//! Renderer-loss recovery policy (#942, #1138): bounded reloads per native
//! window, the recovery document URL, and the shared macOS/Linux recovery path.
use super::reload::*;
use std::time::{Duration, Instant};

// The shipped budget: three reloads per window per minute.
const LIMIT: ReloadLimit = RELOAD_LIMIT;

fn after(start: Instant, seconds: u64) -> Instant {
    start + Duration::from_secs(seconds)
}

/// Apply successive terminations, threading the history like the adapter does.
fn decisions(parked: bool, times: &[Instant]) -> Vec<Recovery> {
    let mut history = ReloadHistory::default();
    times
        .iter()
        .map(|&now| {
            let (decision, next) = plan(&history, Termination::Lost, parked, LIMIT, now);
            history = next;
            decision
        })
        .collect()
}

#[test]
fn reloads_until_the_window_budget_is_spent() {
    let start = Instant::now();
    let times: Vec<_> = (0..5).map(|seconds| after(start, seconds)).collect();
    assert_eq!(
        decisions(false, &times),
        vec![
            Recovery::Reload { attempt: 1 },
            Recovery::Reload { attempt: 2 },
            Recovery::Reload { attempt: 3 },
            Recovery::Exhausted { recent: 3 },
            Recovery::Exhausted { recent: 3 },
        ]
    );
}

#[test]
fn reloads_older_than_the_period_no_longer_count() {
    let start = Instant::now();
    let times = [
        start,
        after(start, 1),
        after(start, 2),
        // The first reload is exactly one period old: it has left the window.
        after(start, 60),
        after(start, 61),
    ];
    assert_eq!(
        decisions(false, &times),
        vec![
            Recovery::Reload { attempt: 1 },
            Recovery::Reload { attempt: 2 },
            Recovery::Reload { attempt: 3 },
            Recovery::Reload { attempt: 3 },
            Recovery::Reload { attempt: 3 },
        ]
    );
}

#[test]
fn an_exhausted_decision_does_not_extend_the_lockout() {
    let start = Instant::now();
    let times = [start, start, start, after(start, 59), after(start, 60)];
    assert_eq!(
        decisions(false, &times)[3..],
        [
            Recovery::Exhausted { recent: 3 },
            Recovery::Reload { attempt: 1 },
        ]
    );
}

#[test]
fn planning_does_not_modify_the_previous_history() {
    let start = Instant::now();
    let empty = ReloadHistory::default();
    let (first, _) = plan(&empty, Termination::Lost, false, LIMIT, start);
    let (again, _) = plan(&empty, Termination::Lost, false, LIMIT, start);
    assert_eq!(first, again);
}

#[test]
fn a_zero_budget_never_reloads() {
    let limit = ReloadLimit {
        max_reloads: 0,
        period: Duration::from_secs(60),
    };
    let (decision, _) = plan(
        &ReloadHistory::default(),
        Termination::Lost,
        false,
        limit,
        Instant::now(),
    );
    assert_eq!(decision, Recovery::Exhausted { recent: 0 });
}

#[test]
fn a_parked_warm_window_is_retired_without_spending_budget() {
    let start = Instant::now();
    let (decision, history) = plan(
        &ReloadHistory::default(),
        Termination::Lost,
        true,
        LIMIT,
        start,
    );
    assert_eq!(decision, Recovery::RetireParked);
    let (next, _) = plan(&history, Termination::Lost, false, LIMIT, start);
    assert_eq!(next, Recovery::Reload { attempt: 1 });
}

#[test]
fn decisions_are_logged_with_their_budget() {
    assert_eq!(
        Recovery::Reload { attempt: 2 }.describe(LIMIT),
        "decision=reload attempt=2 limit=3 period-s=60"
    );
    assert_eq!(
        Recovery::Exhausted { recent: 3 }.describe(LIMIT),
        "decision=exhausted recent=3 limit=3 period-s=60"
    );
    assert_eq!(
        Recovery::RetireParked.describe(LIMIT),
        "decision=retire-parked"
    );
}

fn recovered(url: &str) -> Option<String> {
    recovery_url(&tauri::Url::parse(url).unwrap()).map(String::from)
}

#[test]
fn the_recovery_document_keeps_the_launch_url_and_marks_it_once() {
    assert_eq!(
        recovered("tauri://localhost/").as_deref(),
        Some("tauri://localhost/?rendererRecovery=1")
    );
    assert_eq!(
        recovered("tauri://localhost/index.html?path=%2FUsers%2Fme%2Fa+b&home=%2FUsers%2Fme")
            .as_deref(),
        Some("tauri://localhost/index.html?path=%2FUsers%2Fme%2Fa+b&home=%2FUsers%2Fme&rendererRecovery=1")
    );
    // A second loss of an already recovered document does not stack markers,
    // and a fragment from in-page navigation is not replayed.
    assert_eq!(
        recovered("http://localhost:1420/?rendererRecovery=1&path=%2Fx#frag").as_deref(),
        Some("http://localhost:1420/?path=%2Fx&rendererRecovery=1")
    );
}

#[test]
fn an_activated_warm_window_reloads_with_its_non_warm_identity() {
    // Only activated warm windows are reloaded (parked ones are retired), and
    // they keep `warm=1` in their URL for life. Loading it again would park a
    // visible window and re-register it with the pool.
    let reloaded =
        recovered("tauri://localhost/?warm=1&path=%2Fpark&home=%2FUsers%2Fme&warm=1").unwrap();
    let url = tauri::Url::parse(&reloaded).unwrap();
    let keys: Vec<String> = url.query_pairs().map(|(key, _)| key.into_owned()).collect();
    assert_eq!(keys, ["path", "home", "rendererRecovery"]);
}

#[test]
fn a_document_without_a_hierarchy_falls_back_to_a_plain_reload() {
    assert_eq!(recovered("about:blank"), None);
    assert_eq!(recovered("data:text/html,x"), None);
}

/// Records what the shared recovery path asked its platform adapter to do.
#[derive(Default)]
struct Recorded(std::cell::RefCell<Vec<Effect>>);

#[derive(Clone, Debug, PartialEq)]
enum Effect {
    Reload(Option<String>),
    RetireParked,
    Log(log::Level, String),
}

impl RecoveryEffects for Recorded {
    fn reload(&self, document: Option<tauri::Url>) {
        self.0
            .borrow_mut()
            .push(Effect::Reload(document.map(String::from)));
    }
    fn retire_parked(&self) {
        self.0.borrow_mut().push(Effect::RetireParked);
    }
    fn log(&self, level: log::Level, line: &str) {
        self.0
            .borrow_mut()
            .push(Effect::Log(level, line.to_owned()));
    }
}

impl Recorded {
    fn reloads(&self) -> Vec<Option<String>> {
        self.0
            .borrow()
            .iter()
            .filter_map(|effect| match effect {
                Effect::Reload(document) => Some(document.clone()),
                _ => None,
            })
            .collect()
    }
    fn take(&self) -> Vec<Effect> {
        std::mem::take(&mut self.0.borrow_mut())
    }
}

fn terminate(
    window: &WindowRecovery,
    termination: Termination,
    parked: bool,
    now: Instant,
    effects: &Recorded,
) -> Recovery {
    window.on_terminated("main", "main", termination, parked, now, effects)
}

fn committed(url: &str) -> WindowRecovery {
    let window = WindowRecovery::default();
    window.record_document(&tauri::Url::parse(url).unwrap());
    window
}

#[test]
fn a_crash_reloads_the_committed_document_as_a_recovery() {
    let window = committed("tauri://localhost/?path=%2Fx");
    let effects = Recorded::default();
    terminate(&window, Termination::Lost, false, Instant::now(), &effects);
    assert_eq!(
        effects.take(),
        vec![
            Effect::Log(
                log::Level::Warn,
                "Renderer(recovery): window=main webview=main decision=reload attempt=1 \
                 limit=3 period-s=60 document=recorded"
                    .into()
            ),
            Effect::Reload(Some(
                "tauri://localhost/?path=%2Fx&rendererRecovery=1".into()
            )),
        ]
    );
}

#[test]
fn a_crash_before_any_commit_reloads_in_place() {
    let window = WindowRecovery::default();
    let effects = Recorded::default();
    terminate(&window, Termination::Lost, false, Instant::now(), &effects);
    assert_eq!(effects.reloads(), vec![None]);
    assert!(matches!(
        &effects.take()[0],
        Effect::Log(log::Level::Warn, line) if line.ends_with("document=unrecorded")
    ));
}

#[test]
fn an_api_termination_is_not_reloaded_and_spends_no_budget() {
    let window = committed("tauri://localhost/");
    let effects = Recorded::default();
    let start = Instant::now();
    for parked in [false, false, false, false, true] {
        let decision = terminate(&window, Termination::Deliberate, parked, start, &effects);
        assert_eq!(decision, Recovery::Deliberate);
    }
    let recorded = effects.take();
    assert!(
        recorded
            .iter()
            .all(|effect| matches!(effect, Effect::Log(log::Level::Info, _))),
        "a deliberate teardown must only be logged: {recorded:?}"
    );
    assert_eq!(
        recorded[0],
        Effect::Log(
            log::Level::Info,
            "Renderer(recovery): window=main webview=main decision=none cause=terminated-by-api"
                .into()
        )
    );
    // The full budget is still there for a real loss.
    for attempt in 1..=3 {
        assert_eq!(
            terminate(&window, Termination::Lost, false, start, &effects),
            Recovery::Reload { attempt }
        );
    }
    assert_eq!(effects.reloads().len(), 3);
}

#[test]
fn an_exhausted_budget_stops_reloading_and_says_so() {
    let window = committed("tauri://localhost/");
    let effects = Recorded::default();
    let start = Instant::now();
    for second in 0..3 {
        terminate(
            &window,
            Termination::Lost,
            false,
            after(start, second),
            &effects,
        );
    }
    assert_eq!(effects.reloads().len(), 3);
    effects.take();
    for second in 3..6 {
        terminate(
            &window,
            Termination::Lost,
            false,
            after(start, second),
            &effects,
        );
    }
    let exhausted = Effect::Log(
        log::Level::Error,
        "Renderer(recovery): window=main webview=main decision=exhausted recent=3 \
         limit=3 period-s=60"
            .into(),
    );
    // No reload loop: every further loss is only reported as terminal.
    assert_eq!(
        effects.take(),
        vec![exhausted.clone(), exhausted.clone(), exhausted]
    );
}

#[test]
fn a_crashed_parked_window_is_retired_not_reloaded() {
    let window = committed("tauri://localhost/?warm=1");
    let effects = Recorded::default();
    terminate(&window, Termination::Lost, true, Instant::now(), &effects);
    assert_eq!(
        effects.take(),
        vec![
            Effect::Log(
                log::Level::Warn,
                "Renderer(recovery): window=main webview=main decision=retire-parked".into()
            ),
            Effect::RetireParked,
        ]
    );
}

#[cfg(target_os = "linux")]
#[test]
fn only_a_webkitgtk_api_teardown_is_deliberate() {
    use webkit2gtk::WebProcessTerminationReason as Reason;
    assert_eq!(
        super::linux_termination(Reason::Crashed),
        ("crashed".to_owned(), Termination::Lost)
    );
    assert_eq!(
        super::linux_termination(Reason::ExceededMemoryLimit),
        ("exceeded-memory-limit".to_owned(), Termination::Lost)
    );
    assert_eq!(
        super::linux_termination(Reason::TerminatedByApi),
        ("terminated-by-api".to_owned(), Termination::Deliberate)
    );
}
