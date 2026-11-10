//! Contracts for the single-map warm-pool lifecycle (#1575).
//!
//! `RefPool` is the previous five-collection implementation, kept verbatim as
//! an executable specification. The differential test drives it and the
//! production `PoolState` with identical pseudo-random operation sequences and
//! requires identical results and identical observable state after each step.

use crate::warm_pool::{
    PoolState, Stage, CLAIM_TIMEOUT, SPAWN_TIMEOUT, TARGET_POOL_SIZE, WARM_LABEL_PREFIX,
};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

#[derive(Default)]
struct RefPool {
    ready: Vec<String>,
    activated: HashSet<String>,
    spawns_in_flight: HashMap<String, Instant>,
    claimed: HashMap<String, Instant>,
    retiring: HashSet<String>,
}

impl RefPool {
    fn try_reserve_spawn(&mut self, label: String, now: Instant) -> bool {
        if self.ready.len() + self.spawns_in_flight.len() >= TARGET_POOL_SIZE || self.owns(&label) {
            return false;
        }
        self.spawns_in_flight.insert(label, now);
        true
    }
    fn expire_spawn(&mut self, label: &str, started: Instant) -> bool {
        if self.spawns_in_flight.get(label) != Some(&started) {
            return false;
        }
        self.spawns_in_flight.remove(label);
        self.retiring.insert(label.to_owned());
        true
    }
    fn release_spawn(&mut self, label: &str) {
        self.spawns_in_flight.remove(label);
    }
    fn owns(&self, label: &str) -> bool {
        self.ready.iter().any(|entry| entry == label)
            || self.activated.contains(label)
            || self.claimed.contains_key(label)
            || self.spawns_in_flight.contains_key(label)
            || self.retiring.contains(label)
    }
    fn register(&mut self, label: String, now: Instant) -> bool {
        let Some(started) = self.spawns_in_flight.remove(&label) else {
            return false;
        };
        if now.duration_since(started) >= SPAWN_TIMEOUT || self.owns(&label) {
            return false;
        }
        self.ready.push(label);
        true
    }
    fn claim(&mut self, now: Instant, is_alive: impl Fn(&str) -> bool) -> Option<String> {
        while let Some(label) = self.ready.pop() {
            if is_alive(&label) {
                self.claimed.insert(label.clone(), now);
                return Some(label);
            }
        }
        None
    }
    fn activate(&mut self, label: &str, now: Instant) -> bool {
        let Some(started) = self.claimed.get(label) else {
            return false;
        };
        if now.duration_since(*started) >= CLAIM_TIMEOUT {
            return false;
        }
        self.claimed.remove(label);
        self.activated.insert(label.to_owned());
        true
    }
    fn expire_claim(&mut self, label: &str, started: Instant) -> bool {
        if self.claimed.get(label) != Some(&started) {
            return false;
        }
        self.claimed.remove(label);
        self.retiring.insert(label.to_owned());
        true
    }
    fn is_real(&self, label: &str) -> bool {
        !label.starts_with(WARM_LABEL_PREFIX)
            || self.activated.contains(label)
            || self.claimed.contains_key(label)
    }
    fn parked(&self, label: &str) -> bool {
        label.starts_with(WARM_LABEL_PREFIX) && !self.activated.contains(label)
    }
    fn forget(&mut self, label: &str) -> bool {
        let was_real = self.is_real(label);
        self.ready.retain(|entry| entry != label);
        self.activated.remove(label);
        self.claimed.remove(label);
        self.spawns_in_flight.remove(label);
        self.retiring.remove(label);
        was_real
    }
    fn drain_parked(&mut self) -> Vec<String> {
        let mut labels = std::mem::take(&mut self.ready);
        labels.extend(self.spawns_in_flight.drain().map(|(label, _)| label));
        labels.extend(self.retiring.drain());
        labels
    }
}

// ---- deterministic randomness (no dependencies) ----

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const LABELS: [&str; 5] = [
    "explorer-warm-a",
    "explorer-warm-b",
    "explorer-warm-c",
    "main",
    "explorer-warm-unknown",
];
// Offsets straddle both 30 s timeouts so expiry boundaries are hit.
const OFFSETS: [u64; 7] = [0, 1, 10, 29, 30, 31, 60];

fn at(base: Instant, secs: u64) -> Instant {
    base + Duration::from_secs(secs)
}

/// Everything observable about one label, from either implementation.
#[derive(Debug, PartialEq, Eq)]
struct View {
    owns: bool,
    is_real: bool,
    parked: bool,
    spawning: bool,
    ready_rank: Option<usize>,
}

fn ref_view(r: &RefPool, label: &str) -> (View, Option<Instant>, Option<Instant>, bool, bool) {
    (
        View {
            owns: r.owns(label),
            is_real: r.is_real(label),
            parked: r.parked(label),
            spawning: r.spawns_in_flight.contains_key(label),
            ready_rank: r.ready.iter().position(|l| l == label),
        },
        r.spawns_in_flight.get(label).copied(),
        r.claimed.get(label).copied(),
        r.activated.contains(label),
        r.retiring.contains(label),
    )
}

fn new_view(s: &PoolState, label: &str) -> (View, Option<Instant>, Option<Instant>, bool, bool) {
    let mut ready: Vec<(u64, &String)> = s
        .entries
        .iter()
        .filter_map(|(l, e)| match e.stage {
            Some(Stage::Ready { seq }) => Some((seq, l)),
            _ => None,
        })
        .collect();
    ready.sort();
    let entry = s.entries.get(label);
    let stage = entry.and_then(|e| e.stage);
    (
        View {
            owns: s.owns(label),
            is_real: s.is_real(label),
            parked: s.parked(label),
            spawning: s.is_spawning(label),
            ready_rank: ready.iter().position(|(_, l)| l.as_str() == label),
        },
        match stage {
            Some(Stage::Spawning { since }) => Some(since),
            _ => None,
        },
        match stage {
            Some(Stage::Claimed { since }) => Some(since),
            _ => None,
        },
        stage == Some(Stage::Activated),
        entry.is_some_and(|e| e.retiring),
    )
}

fn assert_same_state(r: &RefPool, s: &PoolState, ctx: &str) {
    for label in LABELS {
        assert_eq!(ref_view(r, label), new_view(s, label), "{ctx}: {label}");
    }
    assert!(
        s.entries.values().all(|e| e.stage.is_some() || e.retiring),
        "{ctx}: empty entry retained"
    );
}

#[test]
fn differential_against_previous_five_collection_model() {
    let base = Instant::now();
    let mut steps = 0u64;
    for seed in 0..6000u64 {
        let mut rng = Lcg(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xC0FFEE);
        let (mut r, mut s) = (RefPool::default(), PoolState::default());
        for step in 0..80 {
            let label = LABELS[rng.below(LABELS.len())];
            let t = at(base, OFFSETS[rng.below(OFFSETS.len())]);
            let op = rng.below(13);
            let ctx = format!("seed {seed} step {step} op {op} {label}");
            match op {
                0 | 1 => assert_eq!(
                    r.try_reserve_spawn(label.into(), t),
                    s.try_reserve_spawn(label.into(), t),
                    "{ctx}"
                ),
                2 => assert_eq!(r.expire_spawn(label, t), s.expire_spawn(label, t), "{ctx}"),
                3 => {
                    r.release_spawn(label);
                    s.release_spawn(label);
                }
                4 | 5 => assert_eq!(
                    r.register(label.into(), t),
                    s.register(label.into(), t),
                    "{ctx}"
                ),
                6 => {
                    let mask = rng.below(8);
                    let (rc, sc) = (RefCell::new(vec![]), RefCell::new(vec![]));
                    let alive =
                        |l: &str| LABELS.iter().position(|x| *x == l).unwrap() % 3 != mask % 3;
                    let a = r.claim(t, |l| {
                        rc.borrow_mut().push(l.to_owned());
                        alive(l)
                    });
                    let b = s.claim(t, |l| {
                        sc.borrow_mut().push(l.to_owned());
                        alive(l)
                    });
                    assert_eq!(a, b, "{ctx}");
                    assert_eq!(rc.into_inner(), sc.into_inner(), "{ctx}: liveness probes");
                }
                7 => assert_eq!(r.activate(label, t), s.activate(label, t), "{ctx}"),
                8 => assert_eq!(r.expire_claim(label, t), s.expire_claim(label, t), "{ctx}"),
                9 => assert_eq!(r.forget(label), s.forget(label), "{ctx}"),
                10 => {
                    // retire_window's failed-destroy path: any phase.
                    r.retiring.insert(label.to_owned());
                    s.mark_retiring(label);
                }
                11 => {
                    // retire_parked: withdraw from claim admission.
                    r.ready.retain(|l| l != label);
                    s.withdraw_ready(label);
                }
                _ => {
                    if rng.below(3) == 0 {
                        // Not reachable via the public API (the target caps the
                        // ready set at one) but exercises ordering/skipping.
                        if !r.owns(label) {
                            r.ready.push(label.to_owned());
                            let seq = s.next_seq;
                            s.next_seq += 1;
                            s.set_stage(label, Some(Stage::Ready { seq }));
                        }
                    } else {
                        let n = r.ready.len();
                        let a = r.drain_parked();
                        let b = s.drain_parked();
                        assert_eq!(a[..n], b[..n], "{ctx}: ready order");
                        let (mut x, mut y) = (a[n..].to_vec(), b[n..].to_vec());
                        x.sort();
                        y.sort();
                        assert_eq!(x, y, "{ctx}: drained rest");
                    }
                }
            }
            assert_same_state(&r, &s, &ctx);
            steps += 1;
        }
    }
    assert_eq!(steps, 480_000);
}

// ---- behavioural contracts ----

const W: &str = "explorer-warm-1";

fn state() -> PoolState {
    PoolState::default()
}

fn ready(s: &mut PoolState, label: &str, now: Instant) {
    assert!(s.try_reserve_spawn(label.into(), now));
    assert!(s.register(label.into(), now));
}

#[test]
fn each_forward_transition_succeeds_once() {
    let (mut s, now) = (state(), Instant::now());
    assert!(s.try_reserve_spawn(W.into(), now));
    assert!(s.is_spawning(W));
    assert!(s.register(W.into(), now));
    assert!(!s.is_spawning(W) && s.holds_live_window(W));
    assert_eq!(s.claim(now, |_| true).as_deref(), Some(W));
    assert!(s.activate(W, now));
    assert!(!s.activate(W, now), "second activation is a no-op");
    assert!(s.forget(W));
    assert!(!s.owns(W));
}

#[test]
fn illegal_transitions_are_rejected_without_effect() {
    let (mut s, now) = (state(), Instant::now());
    assert!(!s.register(W.into(), now), "register without reservation");
    assert!(!s.activate(W, now), "activate unclaimed");
    assert!(!s.expire_spawn(W, now));
    assert!(!s.expire_claim(W, now));
    assert!(!s.owns(W));
    ready(&mut s, W, now);
    assert!(!s.activate(W, now), "activate ready (not claimed)");
    assert!(!s.expire_spawn(W, now), "ready is not a reservation");
    assert!(!s.register(W.into(), now), "re-register ready");
    assert!(s.holds_live_window(W));
    assert!(!s.try_reserve_spawn(W.into(), now), "owned label");
}

#[test]
fn claim_prefers_newest_ready_and_discards_dead_ones() {
    let (mut s, now) = (state(), Instant::now());
    for (i, l) in ["explorer-warm-a", "explorer-warm-b", "explorer-warm-c"]
        .iter()
        .enumerate()
    {
        s.set_stage(l, Some(Stage::Ready { seq: i as u64 }));
        s.next_seq = i as u64 + 1;
    }
    let probes = RefCell::new(vec![]);
    let got = s.claim(now, |l| {
        probes.borrow_mut().push(l.to_owned());
        l == "explorer-warm-b"
    });
    assert_eq!(got.as_deref(), Some("explorer-warm-b"));
    assert_eq!(probes.into_inner(), ["explorer-warm-c", "explorer-warm-b"]);
    assert!(!s.owns("explorer-warm-c"), "dead label discarded");
    assert!(s.holds_live_window("explorer-warm-a"), "older stays ready");
    assert_eq!(s.claim(now, |_| true).as_deref(), Some("explorer-warm-a"));
}

#[test]
fn owns_and_realness_for_every_state() {
    let now = Instant::now();
    let mut spawning = state();
    spawning.try_reserve_spawn(W.into(), now);
    let mut rdy = state();
    ready(&mut rdy, W, now);
    let mut claimed = state();
    ready(&mut claimed, W, now);
    claimed.claim(now, |_| true);
    let mut activated = state();
    ready(&mut activated, W, now);
    activated.claim(now, |_| true);
    activated.activate(W, now);
    let mut retiring = state();
    retiring.mark_retiring(W);
    // (state, is_real, parked)
    for (s, real, parked, name) in [
        (&spawning, false, true, "spawning"),
        (&rdy, false, true, "ready"),
        (&claimed, true, true, "claimed"),
        (&activated, true, false, "activated"),
        (&retiring, false, true, "retiring"),
    ] {
        assert!(s.owns(W), "{name}");
        assert_eq!(s.is_real(W), real, "{name}");
        assert_eq!(s.parked(W), parked, "{name}");
    }
    assert!(!state().owns(W));
}

#[test]
fn spawn_reservation_expires_only_for_the_same_reservation() {
    let (mut s, now) = (state(), Instant::now());
    assert!(s.try_reserve_spawn(W.into(), now));
    assert!(!s.expire_spawn(W, now + Duration::from_secs(1)), "other id");
    assert!(s.expire_spawn(W, now));
    assert!(s.owns(W), "expired boot keeps retirement ownership");
    assert!(!s.is_spawning(W));
    // Slot is free again, but the retiring label cannot be reused.
    assert!(!s.try_reserve_spawn(W.into(), now));
    assert!(s.try_reserve_spawn("explorer-warm-2".into(), now));
}

#[test]
fn late_registration_is_rejected_and_consumes_the_reservation() {
    let (mut s, now) = (state(), Instant::now());
    s.try_reserve_spawn(W.into(), now);
    assert!(!s.register(W.into(), now + SPAWN_TIMEOUT));
    assert!(!s.owns(W));
    s.try_reserve_spawn(W.into(), now);
    assert!(s.register(W.into(), now + SPAWN_TIMEOUT - Duration::from_millis(1)));
}

#[test]
fn claim_timeout_blocks_commit_but_not_watchdog_expiry() {
    let (mut s, now) = (state(), Instant::now());
    ready(&mut s, W, now);
    s.claim(now, |_| true);
    assert!(!s.activate(W, now + CLAIM_TIMEOUT));
    assert!(s.is_real(W), "still claimed until the watchdog fires");
    assert!(!s.expire_claim(W, now + Duration::from_secs(1)), "other id");
    assert!(s.expire_claim(W, now));
    assert!(!s.is_real(W) && s.owns(W));
    let mut ok = state();
    ready(&mut ok, W, now);
    ok.claim(now, |_| true);
    assert!(ok.activate(W, now + CLAIM_TIMEOUT - Duration::from_millis(1)));
}

#[test]
fn retiring_flag_overlaps_a_live_phase_and_survives_transitions() {
    let (mut s, now) = (state(), Instant::now());
    ready(&mut s, W, now);
    s.mark_retiring(W); // failed destroy of a ready window
    assert_eq!(s.claim(now, |_| true).as_deref(), Some(W));
    assert!(s.activate(W, now));
    assert!(s.is_real(W));
    // Drain reports it once, via the retiring group, and leaves activation.
    assert_eq!(s.drain_parked(), vec![W.to_owned()]);
    assert!(s.is_real(W));
    assert!(s.forget(W));
    assert!(!s.owns(W));
}

#[test]
fn drain_lists_ready_and_retiring_duplicates_and_clears_them() {
    let (mut s, now) = (state(), Instant::now());
    ready(&mut s, W, now);
    s.mark_retiring(W);
    assert_eq!(s.drain_parked(), vec![W.to_owned(), W.to_owned()]);
    assert!(!s.owns(W));
    assert!(s.drain_parked().is_empty());
}

#[test]
fn withdraw_ready_only_affects_ready_labels() {
    let (mut s, now) = (state(), Instant::now());
    s.try_reserve_spawn(W.into(), now);
    s.withdraw_ready(W);
    assert!(s.is_spawning(W));
    s.register(W.into(), now);
    s.withdraw_ready(W);
    assert!(!s.owns(W));
    s.withdraw_ready("explorer-warm-never");
    assert!(s.entries.is_empty());
}
