//! Reverse text frames run outside the broker reader. This bridge binds caller
//! identity and liveness before scheduling and reserves cancellation capacity.
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
type Reply = Result<Value, Value>;
type Work = Pin<Box<dyn Future<Output = Reply> + Send>>;
type OwnerCheck = Arc<dyn Fn() -> bool + Send + Sync>;
pub(super) trait TextEngine: Send + Sync {
    fn describe(&self, cancelled: OwnerCheck) -> Work;
    fn generate(&self, caller: String, request: Value, cancelled: OwnerCheck) -> Work;
    fn cancel(&self, caller: &str, request_id: &str) -> bool;
}
pub(super) struct NativeText;
impl TextEngine for NativeText {
    fn describe(&self, cancelled: OwnerCheck) -> Work {
        Box::pin(async move {
            crate::ai::describe_owned(cancelled)
                .await
                .map(|value| json!(value))
                .map_err(|cause| json!(cause))
        })
    }
    fn generate(&self, caller: String, request: Value, cancelled: OwnerCheck) -> Work {
        Box::pin(async move {
            crate::ai::generate_owned(caller, request, cancelled)
                .await
                .map(|value| json!(value))
                .map_err(|cause| json!(cause))
        })
    }
    fn cancel(&self, caller: &str, request_id: &str) -> bool {
        crate::ai::cancel(caller, request_id)
    }
}
pub(super) struct TextBridge {
    caller: String,
    active: Arc<dyn Fn() -> bool + Send + Sync>,
    send: Arc<dyn Fn(Value) + Send + Sync>,
    engine: Arc<dyn TextEngine>,
    pending: AtomicUsize,
}
struct Pending(Arc<TextBridge>);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.pending.fetch_sub(1, Ordering::AcqRel);
    }
}
impl TextBridge {
    pub(super) fn has_pending(&self) -> bool { self.pending.load(Ordering::Acquire) > 0 }
    pub fn new(
        caller: String,
        active: impl Fn() -> bool + Send + Sync + 'static,
        send: impl Fn(Value) + Send + Sync + 'static,
        engine: Arc<dyn TextEngine>,
    ) -> Self {
        Self {
            caller,
            active: Arc::new(active),
            send: Arc::new(send),
            engine,
            pending: AtomicUsize::new(0),
        }
    }
    fn reply(&self, id: &str, result: Reply) {
        let frame = match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":error["message"],"data":error}})
            }
        };
        (self.send)(frame);
    }
    pub fn handle(self: &Arc<Self>, frame: Value) {
        let Some(id) = frame["id"]
            .as_str()
            .filter(|id| id.starts_with("host:") && id.len() <= 128)
        else {
            return;
        };
        if !(self.active)() {
            self.reply(id, Err(json!({"code":"unavailable","message":"Text service requires an active backend"})));
            return;
        }
        let method = frame["method"].as_str().unwrap_or("");
        if method == "host.text.cancel" {
            let Some(request_id) = frame["params"]["requestId"]
                .as_str()
                .filter(|id| crate::ai::domain::valid_id(id))
            else {
                self.reply(
                    id,
                    Err(json!({"code":"invalid_request","message":"Invalid text cancellation ID"})),
                );
                return;
            };
            self.reply(
                id,
                Ok(json!({"cancelled":self.engine.cancel(&self.caller, request_id)})),
            );
            return;
        }
        if !matches!(method, "host.text.describe" | "host.text.generate") {
            self.reply(
                id,
                Err(json!({"code":"invalid_request","message":"Unknown text operation"})),
            );
            return;
        }
        if self
            .pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 8).then_some(n + 1)
            })
            .is_err()
        {
            self.reply(
                id,
                Err(json!({"code":"capacity_reached","message":"Text request capacity reached"})),
            );
            return;
        }
        let owner = self.clone();
        let permit = Pending(owner.clone());
        let describe = method == "host.text.describe";
        let id = id.to_owned();
        tauri::async_runtime::spawn(async move {
            let permit = permit;
            // A broker may die or become inactive between reader admission and
            // execution. The same predicate is retained by the native worker.
            let result = if !(owner.active)() {
                Err(json!({"code":"cancelled","message":"Text caller is no longer active"}))
            } else if describe {
                let active = owner.active.clone();
                owner.engine.describe(Arc::new(move || !active())).await
            } else {
                let active = owner.active.clone();
                owner
                    .engine
                    .generate(
                        owner.caller.clone(),
                        frame["params"].clone(),
                        Arc::new(move || !active()),
                    )
                    .await
            };
            drop(permit);
            owner.reply(&id, result);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicBool, Mutex};
    struct Fixture {
        calls: Arc<Mutex<Vec<String>>>,
        gate: Arc<tokio::sync::Semaphore>,
    }
    impl TextEngine for Fixture {
        fn describe(&self, _: OwnerCheck) -> Work {
            Box::pin(async { Ok(json!({"version":1})) })
        }
        fn generate(&self, caller: String, _: Value, cancelled: OwnerCheck) -> Work {
            let calls = self.calls.clone();
            let gate = self.gate.clone();
            Box::pin(async move {
                let _permit = gate.acquire().await.unwrap();
                if cancelled() {
                    return Err(json!({"code":"cancelled","message":"Cancelled"}));
                }
                calls.lock().unwrap().push(caller);
                Ok(json!({"text":"Ready"}))
            })
        }
        fn cancel(&self, caller: &str, _: &str) -> bool {
            self.calls.lock().unwrap().push(format!("cancel:{caller}"));
            true
        }
    }
    #[test]
    fn preflight_cannot_read_configuration_or_generate() {
        let frames = Arc::new(Mutex::new(vec![]));
        let sink = frames.clone();
        let calls = Arc::new(Mutex::new(vec![]));
        let engine = Arc::new(Fixture {
            calls: calls.clone(),
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
        });
        let bridge = Arc::new(TextBridge::new(
            "trusted-package-1".into(),
            || false,
            move |frame| sink.lock().unwrap().push(frame),
            engine,
        ));
        for method in [
            "host.text.describe",
            "host.text.generate",
            "host.text.cancel",
        ] {
            bridge.handle(json!({"jsonrpc":"2.0","id":"host:1","method":method,"params":{"requestId":"test"}}));
        }
        assert_eq!(frames.lock().unwrap().len(), 3);
        assert!(frames
            .lock()
            .unwrap()
            .iter()
            .all(|frame| frame["error"]["data"]["code"] == "unavailable"));
        assert!(calls.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn reader_keeps_control_capacity_and_queued_work_cannot_outlive_its_incarnation() {
        let (send, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let active = Arc::new(AtomicBool::new(true));
        let liveness = active.clone();
        let calls = Arc::new(Mutex::new(vec![]));
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let bridge = Arc::new(TextBridge::new(
            "trusted-package-1".into(),
            move || liveness.load(Ordering::Acquire),
            move |frame| {
                send.send(frame).unwrap();
            },
            Arc::new(Fixture {
                calls: calls.clone(),
                gate: gate.clone(),
            }),
        ));
        for id in 1..=8 {
            bridge.handle(json!({"jsonrpc":"2.0","id":format!("host:{id}"),"method":"host.text.generate","params":{"requestId":format!("request-{id}"),"caller":"spoofed"}}));
        }
        bridge.handle(
            json!({"jsonrpc":"2.0","id":"host:9","method":"host.text.generate","params":{}}),
        );
        let limit = frames.recv().await.unwrap();
        assert_eq!(limit["id"], "host:9");
        assert_eq!(limit["error"]["data"]["code"], "capacity_reached");
        bridge.handle(json!({"jsonrpc":"2.0","id":"host:10","method":"host.text.cancel","params":{"requestId":"request-1","caller":"replacement"}}));
        let cancelled = frames.recv().await.unwrap();
        assert_eq!(cancelled["id"], "host:10");
        assert_eq!(*calls.lock().unwrap(), vec!["cancel:trusted-package-1"]);
        active.store(false, Ordering::Release);
        gate.add_permits(8);
        for _ in 0..8 {
            let reply = tokio::time::timeout(std::time::Duration::from_secs(2), frames.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(reply["error"]["data"]["code"], "cancelled");
        }
        assert_eq!(*calls.lock().unwrap(), vec!["cancel:trusted-package-1"]);
    }
}
