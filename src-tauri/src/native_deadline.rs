//! Scoped monotonic budgets for a synchronous native recovery attempt.
//! Blocking OS filesystem calls retain their owned worker until return; the
//! budget bounds lock/queue/RPC waits and prevents subsequent work after expiry.
use crate::error::AppError;
use std::{
    cell::Cell,
    sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, TryLockError},
    time::{Duration, Instant},
};
thread_local! {static DEADLINE:Cell<Option<Instant>>=const{Cell::new(None)};}
pub(crate) fn current() -> Option<Instant> {
    DEADLINE.get()
}
fn expired() -> AppError {
    AppError::Service {
        code: "timed_out".into(),
        message: "Native recovery budget elapsed; original operation evidence is retained".into(),
    }
}
pub(crate) fn check() -> Result<(), AppError> {
    if current().is_some_and(|until| Instant::now() >= until) {
        Err(expired())
    } else {
        Ok(())
    }
}
pub(crate) fn remaining(cap: Duration) -> Result<Duration, AppError> {
    check()?;
    Ok(current()
        .map(|until| until.saturating_duration_since(Instant::now()).min(cap))
        .unwrap_or(cap))
}
pub(crate) fn scoped<T>(until: Instant, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<Instant>);
    impl Drop for Restore {
        fn drop(&mut self) {
            DEADLINE.set(self.0)
        }
    }
    let old = current();
    let _restore = Restore(old);
    DEADLINE.set(Some(old.map_or(until, |old| old.min(until))));
    work()
}
pub(crate) fn lock<'a, T>(
    mutex: &'a Mutex<T>,
    message: &str,
) -> Result<MutexGuard<'a, T>, AppError> {
    if current().is_none() {
        return mutex.lock().map_err(|_| AppError::Other(message.into()));
    }
    loop {
        check()?;
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Err(AppError::Other(message.into())),
            Err(TryLockError::WouldBlock) => {
                std::thread::sleep(remaining(Duration::from_millis(5))?)
            }
        }
    }
}
pub(crate) fn read<'a, T>(
    lock: &'a RwLock<T>,
    message: &str,
) -> Result<RwLockReadGuard<'a, T>, AppError> {
    if current().is_none() {
        return lock.read().map_err(|_| AppError::Other(message.into()));
    }
    loop {
        check()?;
        match lock.try_read() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Err(AppError::Other(message.into())),
            Err(TryLockError::WouldBlock) => {
                std::thread::sleep(remaining(Duration::from_millis(5))?)
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_held_startup_lock_consumes_the_same_budget_as_later_rpc_waits() {
        let lock = std::sync::Arc::new(Mutex::new(()));
        let held = lock.lock().unwrap();
        let other = lock.clone();
        let worker = std::thread::spawn(move || {
            scoped(Instant::now() + Duration::from_millis(35), || {
                let started = Instant::now();
                let result = super::lock(&other, "fixture startup");
                assert!(matches!(result,Err(AppError::Service{ref code,..}) if code=="timed_out"));
                assert!(started.elapsed() < Duration::from_secs(1));
                assert!(check().is_err());
            })
        });
        worker.join().unwrap();
        drop(held);
    }
    #[test]
    fn nested_attempts_cannot_extend_an_aggregate_budget() {
        // Generous outer budget: a loaded runner may oversleep, but the nested
        // five-second scope must still never outlive the outer one.
        scoped(Instant::now() + Duration::from_millis(400), || {
            std::thread::sleep(Duration::from_millis(15));
            scoped(Instant::now() + Duration::from_secs(5), || {
                let wait = remaining(Duration::from_secs(15)).unwrap();
                assert!(wait < Duration::from_millis(390));
                let (_send, receive) = std::sync::mpsc::channel::<()>();
                assert!(receive.recv_timeout(wait).is_err());
                assert!(check().is_err());
            });
        });
        assert!(current().is_none());
    }
    #[test]
    fn lifecycle_writer_wait_is_bounded_without_unlocking_another_owner() {
        let lock = std::sync::Arc::new(RwLock::new(()));
        let held = lock.write().unwrap();
        let other = lock.clone();
        std::thread::spawn(move || {
            scoped(Instant::now() + Duration::from_millis(25), || {
                assert!(read(&other, "fixture lifecycle").is_err())
            })
        })
        .join()
        .unwrap();
        assert!(lock.try_read().is_err());
        drop(held);
        assert!(lock.try_read().is_ok());
    }
}
