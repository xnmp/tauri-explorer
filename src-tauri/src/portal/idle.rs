//! When a D-Bus-activated portal backend may exit (#1427).
//!
//! The standard lifecycle for activated session services (GApplication's
//! hold/release plus inactivity timeout, used by the GTK/GNOME portal
//! backends): every request and every picker window holds the process (a
//! window can outlive its request while it is destroyed), and once nothing is
//! held for
//! the idle timeout the service releases its bus name and exits. The bus
//! re-activates the current binary for the next request, which also retires a
//! process whose executable was replaced by an upgrade.
//!
//! Pure state: the caller owns timers, the bus name and process exit, and
//! feeds the outcomes back in. Every transition is a method returning the one
//! effect the caller must perform.
use std::time::Duration;

/// Long enough that picking several files in one task reuses the warm
/// process (a cold start pays for GTK and a WebKit renderer); short enough that
/// an idle backend, or one left running an upgraded-away binary, is gone
/// within a minute.
pub(super) const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Owns the bus name and serves requests.
    Serving,
    /// Releasing (or has released) the bus name; serves stragglers only.
    Retiring,
    /// Exit has been requested; nothing further happens.
    Exited,
}

/// What the caller must do after a transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Effect {
    Nothing,
    /// Call [`IdleState::timer_elapsed`] with `generation` after `delay`.
    ArmTimer {
        generation: u64,
        delay: Duration,
    },
    /// Release the bus name, then call [`IdleState::name_released`].
    ReleaseName,
    /// Exit the process.
    Exit,
}

#[derive(Debug)]
pub(super) struct IdleState {
    held: usize,
    /// Advanced by every hold and every arming, so a timer armed before a
    /// request began can never retire the process after it.
    generation: u64,
    phase: Phase,
    /// The bus confirmed the name release; meaningful only while retiring.
    released: bool,
}

impl IdleState {
    pub(super) fn new() -> Self {
        Self {
            held: 0,
            generation: 0,
            phase: Phase::Serving,
            released: false,
        }
    }

    /// The service owns its bus name. An activation that never receives a
    /// request still exits after the idle delay; requests that arrived while
    /// the connection was being set up arm it themselves when they end.
    pub(super) fn serving(&mut self, delay: Duration) -> Effect {
        if self.held > 0 || self.phase != Phase::Serving {
            return Effect::Nothing;
        }
        self.arm(delay)
    }

    /// A request or picker window began. Holds are admitted in every phase:
    /// a request that reaches a retiring process (sent before the name was
    /// released) is served before exit.
    pub(super) fn hold(&mut self) {
        self.held += 1;
        self.generation += 1;
    }

    /// A request or window ended; `delay` is how long the idle process waits.
    pub(super) fn release(&mut self, delay: Duration) -> Effect {
        self.held = self.held.saturating_sub(1);
        if self.held > 0 {
            return Effect::Nothing;
        }
        match self.phase {
            Phase::Serving => self.arm(delay),
            // The name is already gone (or going): the last straggler ends it.
            Phase::Retiring => self.exit_if_released(),
            Phase::Exited => Effect::Nothing,
        }
    }

    /// An armed timer fired.
    pub(super) fn timer_elapsed(&mut self, generation: u64) -> Effect {
        if self.phase != Phase::Serving || self.held > 0 || generation != self.generation {
            return Effect::Nothing;
        }
        self.phase = Phase::Retiring;
        self.released = false;
        Effect::ReleaseName
    }

    /// The bus no longer routes the well-known name here. Requests already
    /// delivered may still be held; the last of them exits.
    pub(super) fn name_released(&mut self) -> Effect {
        self.released = true;
        if self.phase == Phase::Retiring && self.held == 0 {
            self.phase = Phase::Exited;
            return Effect::Exit;
        }
        Effect::Nothing
    }

    fn exit_if_released(&mut self) -> Effect {
        if self.released {
            self.phase = Phase::Exited;
            Effect::Exit
        } else {
            // `name_released` will see the zero hold count.
            Effect::Nothing
        }
    }

    fn arm(&mut self, delay: Duration) -> Effect {
        self.generation += 1;
        Effect::ArmTimer {
            generation: self.generation,
            delay,
        }
    }
}

/// The idle delay after the last request. An executable replaced on disk
/// (package upgrade) means this process serves stale code: leave at the first
/// idle moment and let the bus activate the new binary for the next request.
pub(super) fn idle_delay(configured: Duration, executable_replaced: bool) -> Duration {
    if executable_replaced {
        Duration::ZERO
    } else {
        configured
    }
}

/// Linux reports an unlinked executable's `/proc/self/exe` target with a
/// " (deleted)" suffix; package managers replace binaries by unlinking.
pub(super) fn is_replaced_executable_link(target: &std::path::Path) -> bool {
    target
        .as_os_str()
        .as_encoded_bytes()
        .ends_with(b" (deleted)")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DELAY: Duration = Duration::from_secs(60);

    fn started() -> (IdleState, Effect) {
        let mut state = IdleState::new();
        let effect = state.serving(DELAY);
        (state, effect)
    }

    fn armed(effect: Effect) -> u64 {
        match effect {
            Effect::ArmTimer { generation, delay } => {
                assert_eq!(delay, DELAY);
                generation
            }
            other => panic!("expected an armed timer, got {other:?}"),
        }
    }

    /// Drives a started service to the point where its name is released.
    fn retire(state: &mut IdleState, generation: u64) {
        assert_eq!(state.timer_elapsed(generation), Effect::ReleaseName);
    }

    #[test]
    fn an_activation_without_requests_exits_after_the_idle_delay() {
        let (mut state, effect) = started();
        let generation = armed(effect);
        retire(&mut state, generation);
        assert_eq!(state.name_released(), Effect::Exit);
    }

    #[test]
    fn a_held_request_keeps_the_service_alive_through_any_timer() {
        let (mut state, effect) = started();
        let startup = armed(effect);
        state.hold();
        // The startup timer fires while a picker is open.
        assert_eq!(state.timer_elapsed(startup), Effect::Nothing);
        let idle = armed(state.release(DELAY));
        retire(&mut state, idle);
        assert_eq!(state.name_released(), Effect::Exit);
    }

    #[test]
    fn a_request_cancels_a_pending_exit_even_after_it_completes() {
        let (mut state, effect) = started();
        let stale = armed(effect);
        state.hold();
        let fresh = armed(state.release(DELAY));
        // The first timer was armed before the request; only the newest counts.
        assert_eq!(state.timer_elapsed(stale), Effect::Nothing);
        retire(&mut state, fresh);
    }

    #[test]
    fn concurrent_requests_arm_only_when_the_last_one_ends() {
        let (mut state, _) = started();
        state.hold();
        state.hold();
        assert_eq!(state.release(DELAY), Effect::Nothing);
        armed(state.release(DELAY));
    }

    #[test]
    fn a_picker_window_outliving_its_request_postpones_exit_until_destroyed() {
        let (mut state, _) = started();
        state.hold(); // request
        state.hold(); // its window
        assert_eq!(state.release(DELAY), Effect::Nothing); // request answered
        let generation = armed(state.release(DELAY)); // window destroyed
        retire(&mut state, generation);
    }

    #[test]
    fn a_request_racing_retirement_is_served_before_exit() {
        let (mut state, effect) = started();
        let generation = armed(effect);
        retire(&mut state, generation);
        // Delivered before the bus processed the release.
        state.hold();
        assert_eq!(state.name_released(), Effect::Nothing);
        assert_eq!(state.release(DELAY), Effect::Exit);
    }

    #[test]
    fn a_straggler_finishing_before_the_release_completes_waits_for_it() {
        let (mut state, effect) = started();
        let generation = armed(effect);
        retire(&mut state, generation);
        state.hold();
        // Finished while ReleaseName was still in flight: not yet safe to exit
        // before the release completes, and no new timer either.
        assert_eq!(state.release(DELAY), Effect::Nothing);
        assert_eq!(state.name_released(), Effect::Exit);
    }

    #[test]
    fn a_request_during_bus_setup_defers_the_first_timer_to_its_end() {
        let mut state = IdleState::new();
        state.hold();
        assert_eq!(state.serving(DELAY), Effect::Nothing);
        let generation = armed(state.release(DELAY));
        retire(&mut state, generation);
    }

    #[test]
    fn exit_is_reported_once() {
        let (mut state, effect) = started();
        let generation = armed(effect);
        retire(&mut state, generation);
        assert_eq!(state.name_released(), Effect::Exit);
        assert_eq!(state.name_released(), Effect::Nothing);
        assert_eq!(state.timer_elapsed(generation), Effect::Nothing);
        state.hold();
        assert_eq!(state.release(DELAY), Effect::Nothing);
    }

    #[test]
    fn an_unbalanced_release_cannot_underflow_into_an_exit() {
        let (mut state, effect) = started();
        let startup = armed(effect);
        let rearmed = armed(state.release(DELAY));
        assert_eq!(state.timer_elapsed(startup), Effect::Nothing);
        retire(&mut state, rearmed);
    }

    #[test]
    fn a_replaced_executable_leaves_at_the_first_idle_moment() {
        assert_eq!(idle_delay(DELAY, false), DELAY);
        assert_eq!(idle_delay(DELAY, true), Duration::ZERO);
    }

    #[test]
    fn recognises_the_kernels_unlinked_executable_marker() {
        use std::path::Path;
        assert!(is_replaced_executable_link(Path::new(
            "/usr/bin/tauri-explorer (deleted)"
        )));
        assert!(!is_replaced_executable_link(Path::new(
            "/usr/bin/tauri-explorer"
        )));
        assert!(!is_replaced_executable_link(Path::new("")));
        // A directory merely named like the marker is not the suffix.
        assert!(!is_replaced_executable_link(Path::new(
            "/opt/x (deleted)/tauri-explorer"
        )));
    }
}
