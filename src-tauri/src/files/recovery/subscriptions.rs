//! One latest recovery channel per renderer incarnation. Monotonic client tokens
//! fence delayed registration/cancellation without retaining per-request tombstones.
use super::model::RecoverySnapshot;
use crate::{error::AppError, renderer_owner::Owner};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};

const MAX_OWNERS: usize = 128;
type SendSnapshot = dyn Fn(&RecoverySnapshot) -> bool + Send + Sync;

#[derive(Clone, Default)]
pub(super) struct Subscriptions(Arc<Mutex<Vec<Renderer>>>);

struct Renderer {
    owner: Owner,
    high_water: u64,
    current: Option<Arc<Delivery>>,
    retirement: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Drop for Renderer {
    fn drop(&mut self) {
        if let Some(delivery) = &self.current {
            delivery.seal();
        }
        if let Some(retirement) = &self.retirement {
            retirement.abort();
        }
    }
}

struct Delivery {
    token: u64,
    owner: Owner,
    sealed: AtomicBool,
    send: Arc<SendSnapshot>,
}

impl Delivery {
    fn seal(&self) {
        self.sealed.store(true, Ordering::Release);
    }
    fn active(&self) -> bool {
        !self.sealed.load(Ordering::Acquire) && self.owner.active()
    }
}

/// Before commit, cancellation or failed initial discovery seals the exact token.
pub(super) struct Registration {
    registry: Subscriptions,
    owner: Owner,
    token: u64,
    committed: bool,
}

impl Registration {
    pub(super) fn commit(mut self) -> Result<(), AppError> {
        let current = self.registry.0.lock().unwrap().iter().any(|entry| {
            entry.owner.same(&self.owner)
                && entry
                    .current
                    .as_ref()
                    .is_some_and(|delivery| delivery.token == self.token && delivery.active())
        });
        if !current {
            return Err(closed());
        }
        self.committed = true;
        Ok(())
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.registry.unsubscribe(&self.owner, self.token);
        }
    }
}

impl Subscriptions {
    pub(super) fn subscribe(
        &self,
        owner: Owner,
        token: u64,
        send: Arc<SendSnapshot>,
    ) -> Result<Registration, AppError> {
        self.update(&owner, token, Some(send))?;
        Ok(Registration {
            registry: self.clone(),
            owner,
            token,
            committed: false,
        })
    }

    pub(super) fn unsubscribe(&self, owner: &Owner, token: u64) -> Result<(), AppError> {
        self.update(owner, token, None)
    }

    fn update(
        &self,
        owner: &Owner,
        token: u64,
        send: Option<Arc<SendSnapshot>>,
    ) -> Result<(), AppError> {
        if token == 0 || token > i64::MAX as u64 {
            return Err(AppError::Other(
                "Recovery subscription token is invalid".into(),
            ));
        }
        if !owner.active() {
            return if send.is_some() {
                Err(closed())
            } else {
                Ok(())
            };
        }
        // Remove retired owners without dropping their tasks/channels under the
        // registry lock. A pending retirement task is not a live capacity claim.
        let retired = {
            let mut entries = self.0.lock().unwrap();
            let (live, retired): (Vec<_>, Vec<_>) = std::mem::take(&mut *entries)
                .into_iter()
                .partition(|entry| entry.owner.active());
            *entries = live;
            retired
        };
        drop(retired);
        let old = {
            let mut entries = self.0.lock().unwrap();
            if !owner.active() {
                return if send.is_some() {
                    Err(closed())
                } else {
                    Ok(())
                };
            }
            let index = match entries.iter().position(|entry| entry.owner.same(owner)) {
                Some(index) => index,
                None => {
                    if entries.len() >= MAX_OWNERS {
                        return Err(AppError::Other("Recovery subscriber limit reached".into()));
                    }
                    let weak = Arc::downgrade(&self.0);
                    let retiring = owner.clone();
                    // The lock stays held until insertion. An already-retired
                    // waiter cannot complete removal before the entry exists.
                    let retirement = tauri::async_runtime::spawn(async move {
                        retiring.retired().await;
                        remove_owner(weak, &retiring);
                    });
                    entries.push(Renderer {
                        owner: owner.clone(),
                        high_water: 0,
                        current: None,
                        retirement: Some(retirement),
                    });
                    entries.len() - 1
                }
            };
            let entry = &mut entries[index];
            if send.is_some() && token <= entry.high_water {
                return Err(closed());
            }
            if token < entry.high_water {
                return Ok(());
            }
            entry.high_water = token;
            let old = entry.current.take();
            if let Some(old) = &old {
                old.seal();
            }
            entry.current = send.map(|send| {
                Arc::new(Delivery {
                    token,
                    owner: owner.clone(),
                    sealed: AtomicBool::new(false),
                    send,
                })
            });
            old
        };
        drop(old);
        Ok(())
    }

    pub(super) fn publish(&self, snapshot: &RecoverySnapshot) {
        let deliveries: Vec<_> = self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|entry| entry.current.clone())
            .collect();
        for delivery in deliveries {
            // A send already in flight can finish after sealing. The renderer
            // callback has its own active/token gate, so it cannot publish then.
            if delivery.active() && !(delivery.send)(snapshot) {
                self.failed_delivery(&delivery);
            }
        }
    }

    fn failed_delivery(&self, delivery: &Arc<Delivery>) {
        let removed = {
            let mut entries = self.0.lock().unwrap();
            entries
                .iter_mut()
                .find(|entry| entry.owner.same(&delivery.owner))
                .and_then(|entry| {
                    if entry
                        .current
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, delivery))
                    {
                        delivery.seal();
                        entry.current.take()
                    } else {
                        None
                    }
                })
        };
        drop(removed);
    }
}

fn remove_owner(registry: Weak<Mutex<Vec<Renderer>>>, owner: &Owner) {
    let Some(registry) = registry.upgrade() else {
        return;
    };
    let removed = {
        let mut entries = registry.lock().unwrap();
        entries
            .iter()
            .position(|entry| entry.owner.same(owner))
            .map(|index| entries.swap_remove(index))
    };
    if let Some(mut removed) = removed {
        // This is the retirement task itself; detach its handle as it returns.
        removed.retirement.take();
        drop(removed);
    }
}

fn closed() -> AppError {
    AppError::Other("Recovery subscription was retired or replaced".into())
}

#[cfg(test)]
#[path = "../../../test_support/recovery_subscriptions.rs"]
mod tests;
