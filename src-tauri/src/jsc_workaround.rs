//! JavaScriptCore options set before WebKitGTK starts (Linux, #1026).
//!
//! On WebKitGTK 2.52 the WebContent process intermittently aborts in the
//! collector: `WTFCrashWithInfoImpl` <- `JSC::MarkedBlock::aboutToMarkSlow`
//! on a GC marker thread, which is JSC's check for a cell pointer into a
//! block that is no longer a live MarkedBlock. The page dies, usually about a
//! second after launch, and the app logs `Renderer(web-content-terminated)
//! ... reason=crashed`. Linux does not reload a lost page, so the window is
//! left blank. On the Linux native smoke this surfaced as "page crash or hang"
//! in whichever spec was running at the time. In a single-profile CI loop that
//! amplifies the crash (three full suites per job), every job had renderer
//! crashes with WebKit's defaults. With the DFG tier disabled (`useDFGJIT=0`,
//! which also disables FTL) there were none. Disabling only FTL, concurrent
//! JIT, concurrent GC, parallel marking, or opportunistic GC did not remove the
//! crash.
//!
//! Cost: hot JavaScript stops at the Baseline JIT instead of reaching the
//! optimizing tiers. App startup in CI stayed within runner variance, and the
//! UI is DOM-bound rather than compute-bound, but long-running hot loops run
//! slower.
//!
//! Scope: only the WebKitGTK series with observed crashes, and never over a
//! value the user set themselves. Retire this when the affected series is no
//! longer supported, or when an upstream fix lands in that series' updates.
//!
//! JSC reads `JSC_<option>` from the environment when it initialises. The
//! WebContent process inherits this process's environment, so the variable
//! must be set before GTK/WebKit start, while the process is single-threaded.

/// The JSC option that disables the DFG (and therefore FTL) tier.
const DFG_VAR: &str = "JSC_useDFGJIT";

/// WebKitGTK `(major, minor)` series with the crash on record (#1026).
const AFFECTED_SERIES: &[(u32, u32)] = &[(2, 52)];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum JscPlan {
    /// Set `JSC_useDFGJIT=0`.
    DisableDfg,
    /// The user already set the option; leave it as they chose.
    UserChoice(String),
    /// This WebKitGTK series has no crash on record; keep JSC's defaults.
    Unaffected,
}

/// Decide for WebKitGTK `webkit`, reading the environment through `get`.
pub(crate) fn plan(webkit: (u32, u32), get: impl Fn(&str) -> Option<String>) -> JscPlan {
    if let Some(value) = get(DFG_VAR) {
        return JscPlan::UserChoice(value);
    }
    if AFFECTED_SERIES.contains(&webkit) {
        JscPlan::DisableDfg
    } else {
        JscPlan::Unaffected
    }
}

/// Apply the plan to this process. Must run before GTK or WebKit is
/// initialised and while the process is still single-threaded.
pub(crate) fn apply(webkit: (u32, u32)) -> JscPlan {
    let plan = plan(webkit, |name| {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    });
    if plan == JscPlan::DisableDfg {
        std::env::set_var(DFG_VAR, "0");
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unset(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn the_affected_series_disables_the_dfg_tier() {
        assert_eq!(plan((2, 52), unset), JscPlan::DisableDfg);
    }

    #[test]
    fn other_series_keep_jsc_defaults() {
        for webkit in [(2, 50), (2, 54), (2, 56), (3, 52), (0, 0)] {
            assert_eq!(plan(webkit, unset), JscPlan::Unaffected, "{webkit:?}");
        }
    }

    #[test]
    fn a_user_value_wins_even_when_empty_or_enabling() {
        for value in ["0", "1", "true", ""] {
            let get = |name: &str| (name == DFG_VAR).then(|| value.to_owned());
            assert_eq!(plan((2, 52), get), JscPlan::UserChoice(value.to_owned()));
        }
    }

    #[test]
    fn unrelated_jsc_variables_do_not_count_as_a_choice() {
        let get = |name: &str| (name == "JSC_useJIT").then(|| "1".to_owned());
        assert_eq!(plan((2, 52), get), JscPlan::DisableDfg);
    }
}
