//! WebKit owns the GTK source. Observe that widget's context lifetime without
//! starting a second drag; native and renderer completion share one sink.
use gtk::{glib::SignalHandlerId, prelude::*};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
};

type Completion = Box<dyn FnOnce(drag::DragResult)>;
struct Callbacks {
    bind: Option<Box<dyn FnOnce(super::NativeContext)>>,
    complete: Completion,
}
const CONTEXT_HISTORY: usize = 8;
static NEXT_CONTEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
struct Context {
    // Keep identities alive until their bounded history entry is evicted. GTK
    // addresses must not be recycled into a later unrelated native gesture.
    _context: gtk::gdk::DragContext,
    _window: gtk::gdk::Window,
    id: usize,
    token: usize,
    window: usize,
    session: Option<String>,
    ended: bool,
}
struct Source<T> {
    session: String,
    context: Option<usize>,
    completion: T,
    paths: Vec<String>,
}
#[derive(Default)]
struct Lifecycle<T> {
    source: Option<Source<T>>,
}
impl<T> Lifecycle<T> {
    fn adopt(&mut self, session: &str, paths: Vec<String>, completion: T) -> Option<T> {
        self.source
            .replace(Source {
                session: session.into(),
                context: None,
                completion,
                paths,
            })
            .map(|source| source.completion)
    }
    fn bind(&mut self, session: &str, context: usize) -> Option<&mut T> {
        if let Some(source) = self.source.as_mut().filter(|source| {
            source.session == session
                && (source.context.is_none() || source.context == Some(context))
        }) {
            source.context = Some(context);
            return Some(&mut source.completion);
        }
        None
    }
    fn end_context(&mut self, context: usize) -> Option<T> {
        if self
            .source
            .as_ref()
            .is_some_and(|source| source.context == Some(context))
        {
            self.source.take().map(|source| source.completion)
        } else {
            None
        }
    }
    fn end_session(&mut self, session: &str) -> Option<T> {
        if self
            .source
            .as_ref()
            .is_some_and(|source| source.session == session)
        {
            self.source.take().map(|source| source.completion)
        } else {
            None
        }
    }
    fn native_active(&self, session: &str) -> bool {
        self.source
            .as_ref()
            .is_some_and(|source| source.session == session && source.context.is_some())
    }
}
struct Tracker {
    view: gtk::glib::WeakRef<webkit2gtk::WebView>,
    handlers: Vec<SignalHandlerId>,
    lifecycle: Lifecycle<Callbacks>,
    contexts: VecDeque<Context>,
}
thread_local! {
    static VIEWS: RefCell<HashMap<String, Tracker>> = RefCell::new(HashMap::new());
}

pub(super) fn watch(owner: &str, view: &webkit2gtk::WebView) {
    let same_view = VIEWS.with(|views| {
        views
            .borrow()
            .get(owner)
            .is_some_and(|tracker| tracker.view.upgrade().as_ref() == Some(view))
    });
    if same_view {
        return;
    }
    destroy(owner);
    let mut handlers = Vec::new();
    {
        let owner = owner.to_owned();
        handlers.push(view.connect_drag_begin(move |_, context| {
            let id = context.as_ptr() as usize;
            let window = source_window(context);
            let token = NEXT_CONTEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            VIEWS.with(|views| {
                if let Some(tracker) = views.borrow_mut().get_mut(&owner) {
                    tracker.contexts.retain(|old| old.id != id);
                    tracker.contexts.push_back(Context {
                        _context: context.clone(),
                        _window: context.source_window(),
                        id,
                        token,
                        window,
                        session: None,
                        ended: false,
                    });
                    while tracker.contexts.len() > CONTEXT_HISTORY {
                        tracker.contexts.pop_front();
                    }
                }
            });
        }));
    }
    {
        let owner = owner.to_owned();
        // WebKit's default class handler populates SelectionData. The AFTER
        // handler sees its immutable source HTML, never receiver-provided HTML.
        handlers.push(view.connect_local("drag-data-get", true, move |values| {
            let context = values[1]
                .get::<gtk::gdk::DragContext>()
                .expect("GTK drag context");
            let data = values[2]
                .get::<&gtk::SelectionData>()
                .expect("GTK selection data");
            source_data(&owner, context.as_ptr() as usize, data);
            None
        }));
    }
    {
        let owner = owner.to_owned();
        handlers.push(view.connect_drag_end(move |_, context| {
            end_context(&owner, context.as_ptr() as usize, drag::DragResult::Dropped);
        }));
    }
    {
        let owner = owner.to_owned();
        handlers.push(view.connect_drag_failed(move |_, context, _| {
            end_context(&owner, context.as_ptr() as usize, drag::DragResult::Cancel);
            gtk::glib::Propagation::Proceed
        }));
    }
    {
        let owner = owner.to_owned();
        handlers.push(view.connect_destroy(move |_| destroy(&owner)));
    }
    VIEWS.with(|views| {
        views.borrow_mut().insert(
            owner.to_owned(),
            Tracker {
                view: view.downgrade(),
                handlers,
                lifecycle: Lifecycle { source: None },
                contexts: VecDeque::new(),
            },
        )
    });
}
fn end_context(owner: &str, context: usize, result: drag::DragResult) {
    let completion = VIEWS.with(|views| {
        views.borrow_mut().get_mut(owner).and_then(|tracker| {
            if let Some(observed) = tracker
                .contexts
                .iter_mut()
                .find(|observed| observed.id == context)
            {
                observed.ended = true;
            }
            tracker.lifecycle.end_context(context)
        })
    });
    if let Some(completion) = completion {
        (completion.complete)(result);
    }
}
fn destroy(owner: &str) {
    let tracker = VIEWS.with(|views| views.borrow_mut().remove(owner));
    if let Some(mut tracker) = tracker {
        if let Some(view) = tracker.view.upgrade() {
            for handler in tracker.handlers {
                view.disconnect(handler);
            }
        }
        if let Some(source) = tracker.lifecycle.source.take() {
            (source.completion.complete)(drag::DragResult::Cancel);
        }
    }
}
fn source_window(context: &gtk::gdk::DragContext) -> usize {
    // SAFETY: GTK supplies a live source context during this signal.
    unsafe { gtk::gdk::ffi::gdk_drag_context_get_source_window(context.as_ptr()) as usize }
}
fn token_for_window(
    contexts: impl Iterator<Item = (usize, usize)>,
    window: usize,
) -> Option<usize> {
    contexts
        .filter(|(candidate, _)| *candidate == window)
        .map(|(_, token)| token)
        .max()
}
pub(super) fn context_for_window(window: usize) -> Option<usize> {
    VIEWS.with(|views| {
        token_for_window(
            views.borrow().values().flat_map(|tracker| {
                tracker
                    .contexts
                    .iter()
                    .map(|context| (context.window, context.token))
            }),
            window,
        )
    })
}

pub(super) fn native_active(owner: &str, session: &str) -> bool {
    VIEWS.with(|views| {
        views
            .borrow()
            .get(owner)
            .is_some_and(|tracker| tracker.lifecycle.native_active(session))
    })
}
pub(super) fn finish(owner: &str, session: &str) {
    let completion = VIEWS.with(|views| {
        views
            .borrow_mut()
            .get_mut(owner)
            .and_then(|tracker| tracker.lifecycle.end_session(session))
    });
    if let Some(completion) = completion {
        (completion.complete)(drag::DragResult::Cancel);
    }
}
pub(super) fn observe(
    owner: &str,
    session: &str,
    paths: Vec<String>,
    view: &webkit2gtk::WebView,
    bind: impl FnOnce(super::NativeContext) + 'static,
    complete: impl FnOnce(drag::DragResult) + 'static,
) -> Result<(), String> {
    watch(owner, view);
    let old = VIEWS.with(|views| {
        let mut views = views.borrow_mut();
        let tracker = views.get_mut(owner).unwrap();
        let known = tracker
            .contexts
            .iter()
            .rev()
            .find(|context| context.session.as_deref() == Some(session));
        if known.is_some_and(|context| context.ended) {
            return Err(String::from("HTML5 native source already ended"));
        }
        let context = known.map(|context| (context.id, context.token));
        let old = tracker.lifecycle.adopt(
            session,
            paths,
            Callbacks {
                bind: Some(Box::new(bind)),
                complete: Box::new(complete),
            },
        );
        let bound = context.and_then(|(context, window)| {
            tracker
                .lifecycle
                .bind(session, context)
                .and_then(|callbacks| callbacks.bind.take())
                .map(|bind| (bind, window))
        });
        Ok((old, bound))
    })?;
    if let Some(old) = old.0 {
        (old.complete)(drag::DragResult::Cancel);
    }
    if let Some((bind, context)) = old.1 {
        bind(context);
    }
    Ok(())
}

fn source_session(html: &[u8]) -> Option<String> {
    let html = std::str::from_utf8(html).ok()?;
    let (_, tail) = html.split_once("urn:tauri-explorer:drag:")?;
    let session = tail
        .split(|ch: char| ch == '<' || ch.is_whitespace())
        .next()?;
    (!session.is_empty()
        && session.len() <= 128
        && session
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-'))
    .then(|| session.to_owned())
}
fn source_data(owner: &str, context: usize, data: &gtk::SelectionData) {
    let target = data.target().name();
    if target == "text/html" && (1..=64 * 1024).contains(&data.length()) {
        if let Some(session) = source_session(&data.data()) {
            let outcome = VIEWS.with(|views| {
                views.borrow_mut().get_mut(owner).and_then(|tracker| {
                    let observed = tracker
                        .contexts
                        .iter_mut()
                        .find(|observed| observed.id == context)?;
                    observed.session = Some(session.clone());
                    let token = observed.token;
                    if observed.ended {
                        return tracker
                            .lifecycle
                            .end_session(&session)
                            .map(|completion| (None, Some(completion)));
                    }
                    tracker
                        .lifecycle
                        .bind(&session, context)
                        .and_then(|callbacks| callbacks.bind.take())
                        .map(|bind| (Some((bind, token)), None))
                })
            });
            if let Some((bind, complete)) = outcome {
                if let Some((bind, token)) = bind {
                    bind(token);
                }
                if let Some(complete) = complete {
                    (complete.complete)(drag::DragResult::Cancel);
                }
            }
        }
    } else if target == "text/uri-list" {
        let paths = VIEWS.with(|views| {
            views.borrow().get(owner).and_then(|tracker| {
                tracker
                    .lifecycle
                    .source
                    .as_ref()
                    .filter(|source| {
                        source.context == Some(context)
                            && tracker.contexts.iter().any(|observed| {
                                observed.id == context
                                    && observed.session.as_deref() == Some(source.session.as_str())
                            })
                    })
                    .map(|source| source.paths.clone())
            })
        });
        if let Some(paths) = paths {
            // WebKit sanitizes a multi-URI DOM string as one URL. The verified
            // native source exports every original file through GTK instead.
            let uris: Vec<String> = paths
                .iter()
                .filter_map(|path| {
                    gtk::glib::filename_to_uri(path, None)
                        .ok()
                        .map(|uri| uri.to_string())
                })
                .collect();
            if uris.len() == paths.len() {
                data.set_uris(&uris.iter().map(String::as_str).collect::<Vec<_>>());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{source_session, token_for_window, Lifecycle};
    #[test]
    fn pooled_ipc_window_uses_newest_context_across_all_source_owners() {
        assert_eq!(
            token_for_window([(77, 3), (88, 9), (77, 1), (77, 7)].into_iter(), 77),
            Some(7)
        );
        assert_eq!(token_for_window([(77, 3)].into_iter(), 88), None);
    }
    #[test]
    fn source_marker_accepts_webkit_html_but_not_unbounded_or_malformed_identity() {
        assert_eq!(
            source_session(br#"<span style="color: black">urn:tauri-explorer:drag:abc-123</span>"#),
            Some("abc-123".into())
        );
        for html in [
            b"urn:tauri-explorer:drag:".as_slice(),
            b"urn:tauri-explorer:drag:abc/def",
            b"plain text",
            &[0xff],
        ] {
            assert_eq!(source_session(html), None);
        }
        assert_eq!(
            source_session(format!("urn:tauri-explorer:drag:{}", "x".repeat(129)).as_bytes()),
            None
        );
    }
    #[test]
    fn old_context_and_old_renderer_completion_cannot_retire_replacement() {
        let mut lifecycle = Lifecycle { source: None };
        assert_eq!(lifecycle.adopt("a", vec![], "complete-a"), None);
        lifecycle.bind("a", 10);
        assert_eq!(
            lifecycle.adopt("b", vec![], "complete-b"),
            Some("complete-a")
        );
        lifecycle.bind("b", 20);
        assert_eq!(lifecycle.end_context(10), None);
        assert_eq!(lifecycle.end_session("a"), None);
        assert!(lifecycle.native_active("b"));
        assert_eq!(lifecycle.end_context(20), Some("complete-b"));
        assert_eq!(lifecycle.end_session("b"), None);
    }
    #[test]
    fn unmarked_old_context_cannot_bind_or_complete_a_pending_successor() {
        let mut lifecycle = Lifecycle { source: None };
        lifecycle.adopt("a", vec![], "complete-a");
        assert_eq!(
            lifecycle.adopt("b", vec![], "complete-b"),
            Some("complete-a")
        );
        assert_eq!(lifecycle.end_context(10), None);
        assert_eq!(lifecycle.bind("a", 10), None);
        assert_eq!(lifecycle.bind("b", 20), Some(&mut "complete-b"));
        assert_eq!(lifecycle.end_context(10), None);
        assert_eq!(lifecycle.end_context(20), Some("complete-b"));
    }
    #[test]
    fn late_adoption_awaits_exact_html_identity_instead_of_guessing_a_context() {
        let mut lifecycle = Lifecycle { source: None };
        lifecycle.adopt("late", vec![], "complete-late");
        assert_eq!(lifecycle.end_context(10), None);
        assert!(!lifecycle.native_active("late"));
        assert_eq!(lifecycle.bind("other", 10), None);
        assert_eq!(lifecycle.bind("late", 20), Some(&mut "complete-late"));
        assert!(lifecycle.native_active("late"));
        assert_eq!(lifecycle.end_session("late"), Some("complete-late"));
    }
}
