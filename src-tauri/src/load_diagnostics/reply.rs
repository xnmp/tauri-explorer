//! Keep a listing's trace open until its reply is encoded (#1022).
//!
//! For a very large folder, encoding the reply takes long enough to matter,
//! and it used to happen after the trace had settled, so the delay was blamed
//! on the last scan phase. Listings are now encoded to bytes inside the
//! command (#1417), timed as [`Phase::Serialize`], and the trace settles once
//! the body exists. Tauri then sends the bytes as they are.
use super::trace::{Phase, TraceScope};
use crate::error::AppError;

/// Encode a command result as a raw IPC reply, settling `scope` with its
/// outcome: a success after `encode` has run, an error at once.
pub(crate) fn encoded_reply<T>(
    scope: TraceScope,
    result: Result<T, AppError>,
    encode: impl FnOnce(&T) -> Vec<u8>,
) -> Result<tauri::ipc::Response, AppError> {
    match result {
        Ok(value) => {
            scope.handle().enter(Phase::Serialize);
            let body = encode(&value);
            scope.finish(&Ok::<(), ()>(()));
            Ok(tauri::ipc::Response::new(body))
        }
        Err(error) => {
            scope.finish(&Err::<(), _>(&error));
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::load_diagnostics::trace::{snapshot, Outcome};
    use std::time::Duration;

    #[test]
    fn encoding_time_is_attributed_to_serialize_not_the_scan() {
        let id = "1700000000000-reply1";
        let scope = TraceScope::begin(Some(id.into()), "/huge");
        scope.handle().enter(Phase::EntryMetadata);
        let reply = encoded_reply(scope, Ok("listing"), |value| {
            std::thread::sleep(Duration::from_millis(120));
            value.as_bytes().to_vec()
        });
        assert!(reply.is_ok());
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
    }

    #[test]
    fn an_error_settles_at_once_without_encoding() {
        let failed = "1700000000000-reply2";
        let result = encoded_reply::<()>(
            TraceScope::begin(Some(failed.into()), "/gone"),
            Err(AppError::Other("missing".into())),
            |_| unreachable!("an error is never encoded"),
        );
        assert!(result.is_err());
        assert_eq!(snapshot(failed).unwrap().outcome, Outcome::Error);
    }
}
