//! Keep a listing's trace open until its reply is encoded (#1022).
//!
//! Tauri serializes a command's return value after the command future
//! completes. For a very large folder that encoding can take seconds, and it
//! used to happen after the trace had settled, so the delay was blamed on
//! the last scan phase. A [`TracedReply`] owns the trace scope and settles it
//! from inside `Serialize`, timing the encoding as [`Phase::Serialize`].
use super::trace::{Phase, TraceScope};
use crate::error::AppError;
use serde::{Serialize, Serializer};
use std::sync::Mutex;

pub struct TracedReply<T> {
    value: T,
    /// Taken by the first serialization; dropping an unsent reply settles
    /// the trace as cancelled.
    scope: Mutex<Option<TraceScope>>,
}

impl<T> TracedReply<T> {
    /// Wrap a command result: a success keeps the trace open until encoded,
    /// an error settles it at once.
    pub(crate) fn wrap(scope: TraceScope, result: Result<T, AppError>) -> Result<Self, AppError> {
        match result {
            Ok(value) => {
                scope.handle().enter(Phase::Respond);
                Ok(Self {
                    value,
                    scope: Mutex::new(Some(scope)),
                })
            }
            Err(error) => {
                scope.finish(&Err::<(), _>(&error));
                Err(error)
            }
        }
    }

    fn take_scope(&self) -> Option<TraceScope> {
        self.scope
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
}

impl<T: Serialize> Serialize for TracedReply<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let scope = self.take_scope();
        if let Some(scope) = &scope {
            scope.handle().enter(Phase::Serialize);
        }
        let result = self.value.serialize(serializer);
        if let Some(scope) = scope {
            scope.finish(&result);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::load_diagnostics::trace::{snapshot, Outcome};
    use std::time::Duration;

    /// Stands in for a listing whose encoding is slow.
    struct SlowToEncode(Duration);

    impl Serialize for SlowToEncode {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            std::thread::sleep(self.0);
            serializer.serialize_str("listing")
        }
    }

    #[test]
    fn encoding_time_is_attributed_to_serialize_not_the_scan() {
        let id = "1700000000000-reply1";
        let scope = TraceScope::begin(Some(id.into()), "/huge");
        scope.handle().enter(Phase::EntryMetadata);
        let reply = TracedReply::wrap(scope, Ok(SlowToEncode(Duration::from_millis(120)))).unwrap();
        let waiting = snapshot(id).unwrap();
        assert_eq!(
            waiting.outcome,
            Outcome::Pending,
            "not settled until encoded"
        );
        assert_eq!(waiting.pending_phase, Some(Phase::Respond));

        assert_eq!(serde_json::to_string(&reply).unwrap(), "\"listing\"");
        let settled = snapshot(id).unwrap();
        assert_eq!(settled.outcome, Outcome::Ok);
        let phase = |wanted: Phase| {
            settled
                .phases
                .iter()
                .find(|phase| phase.phase == wanted)
                .unwrap()
                .duration_ms
        };
        assert!(phase(Phase::Serialize) >= 120);
        assert!(phase(Phase::EntryMetadata) < 120, "scan is not blamed");
        // A second encoding neither re-times nor re-settles.
        assert_eq!(serde_json::to_string(&reply).unwrap(), "\"listing\"");
        assert_eq!(snapshot(id).unwrap().phases, settled.phases);
    }

    #[test]
    fn an_error_settles_at_once_and_an_unsent_reply_is_cancelled() {
        let failed = "1700000000000-reply2";
        let result = TracedReply::<()>::wrap(
            TraceScope::begin(Some(failed.into()), "/gone"),
            Err(AppError::Other("missing".into())),
        );
        assert!(result.is_err());
        assert_eq!(snapshot(failed).unwrap().outcome, Outcome::Error);

        let dropped = "1700000000000-reply3";
        drop(TracedReply::wrap(
            TraceScope::begin(Some(dropped.into()), "/a"),
            Ok(()),
        ));
        assert_eq!(snapshot(dropped).unwrap().outcome, Outcome::Cancelled);
    }
}
