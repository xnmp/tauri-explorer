//! An acknowledged renderer controls one ordered native session. Decisions are
//! single-use and fenced to an item; cancellation also wakes a paused session.
use super::model::{Choice, Conflict, Decision, Event};
use crate::{error::AppError, renderer_owner::Owner};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use tokio::sync::oneshot;

struct Pending {
    item: usize,
    nonce: u64,
    reply: oneshot::Sender<Decision>,
}

pub(crate) struct Control {
    pub renderer: Owner,
    pub cancelled: Owner,
    pending: Mutex<Option<Pending>>,
}

impl Control {
    pub(crate) fn new(renderer: Owner) -> Self {
        Self {
            renderer,
            cancelled: Owner::default(),
            pending: Mutex::new(None),
        }
    }

    pub(crate) async fn decide(
        &self,
        item: usize,
        conflict: Conflict,
        emit: &impl Fn(Event) -> bool,
    ) -> Decision {
        let stop = Decision {
            choice: Choice::Cancel,
            apply_to_all: false,
        };
        if !self.renderer.active() || !self.cancelled.active() {
            return stop;
        }
        // Process-wide, never reused even when a client reuses its request ID.
        static NEXT_NONCE: AtomicU64 = AtomicU64::new(1);
        let Ok(nonce) = NEXT_NONCE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |next| {
            next.checked_add(1)
        }) else {
            return stop;
        };
        let (reply, receive) = oneshot::channel();
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Pending { item, nonce, reply });
        // Install authority before sending. The renderer can reply immediately.
        if !emit(Event::Conflict {
            item,
            nonce: nonce.to_string(),
            conflict,
        }) {
            self.cancelled.retire();
        }
        let decision = tokio::select! {
            biased;
            _ = self.renderer.retired() => stop,
            _ = self.cancelled.retired() => stop,
            decision = receive => decision.unwrap_or(stop),
        };
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        decision
    }

    pub(crate) fn resolve(
        &self,
        renderer: &Owner,
        item: usize,
        nonce: &str,
        decision: Decision,
    ) -> Result<(), AppError> {
        self.authorize(renderer)?;
        let nonce = nonce.parse::<u64>().map_err(|_| stale())?;
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if !pending
            .as_ref()
            .is_some_and(|pending| pending.item == item && pending.nonce == nonce)
        {
            return Err(stale());
        }
        pending
            .take()
            .unwrap()
            .reply
            .send(decision)
            .map_err(|_| stale())
    }

    fn authorize(&self, renderer: &Owner) -> Result<(), AppError> {
        if !renderer.active() || !self.renderer.same(renderer) || !self.cancelled.active() {
            Err(stale())
        } else {
            Ok(())
        }
    }

    pub(crate) fn cancel(&self, renderer: &Owner) -> Result<(), AppError> {
        self.authorize(renderer)?;
        self.cancelled.retire();
        Ok(())
    }
}

fn stale() -> AppError {
    AppError::Other("Native session or conflict decision is no longer active".into())
}

struct Entry {
    id: String,
    control: Arc<Control>,
}
static SESSIONS: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
fn sessions() -> &'static Mutex<Vec<Entry>> {
    SESSIONS.get_or_init(|| Mutex::new(Vec::new()))
}

pub(crate) struct Registration {
    pub control: Arc<Control>,
}
impl Registration {
    pub(crate) fn new(id: String, renderer: Owner) -> Result<Self, AppError> {
        if id.is_empty()
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(AppError::InvalidPath("Invalid native session ID".into()));
        }
        let mut sessions = sessions().lock().unwrap_or_else(|e| e.into_inner());
        if !renderer.active()
            || sessions.len() >= 128
            || sessions
                .iter()
                .any(|entry| entry.id == id && entry.control.renderer.same(&renderer))
        {
            return Err(AppError::Other(
                "Native session is already active or the session limit was reached".into(),
            ));
        }
        let control = Arc::new(Control::new(renderer));
        sessions.push(Entry {
            id: id.clone(),
            control: control.clone(),
        });
        Ok(Self { control })
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        sessions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|entry| !Arc::ptr_eq(&entry.control, &self.control));
    }
}

pub(crate) fn lookup(id: &str, renderer: &Owner) -> Result<Arc<Control>, AppError> {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|entry| entry.id == id && entry.control.renderer.same(renderer))
        .map(|entry| entry.control.clone())
        .ok_or_else(stale)
}
