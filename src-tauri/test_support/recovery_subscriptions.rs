use super::*;
use std::sync::atomic::AtomicUsize;

fn snapshot() -> RecoverySnapshot {
    RecoverySnapshot {
        storage: Default::default(),
        revision: 1,
        items: vec![],
        error: None,
    }
}

fn counter(count: &Arc<AtomicUsize>) -> Arc<SendSnapshot> {
    let count = count.clone();
    Arc::new(move |_| {
        count.fetch_add(1, Ordering::Relaxed);
        true
    })
}

#[test]
fn replacement_and_delayed_releases_preserve_only_latest_channel() {
    let registry = Subscriptions::default();
    let owner = Owner::default();
    let old = Arc::new(AtomicUsize::new(0));
    let latest = Arc::new(AtomicUsize::new(0));
    registry
        .subscribe(owner.clone(), 1, counter(&old))
        .unwrap()
        .commit()
        .unwrap();
    registry
        .subscribe(owner.clone(), 3, counter(&latest))
        .unwrap()
        .commit()
        .unwrap();
    registry.unsubscribe(&owner, 1).unwrap();
    assert!(registry.subscribe(owner.clone(), 2, counter(&old)).is_err());
    registry.publish(&snapshot());
    assert_eq!(old.load(Ordering::Relaxed), 0);
    assert_eq!(latest.load(Ordering::Relaxed), 1);
    registry.unsubscribe(&owner, 3).unwrap();
    registry.publish(&snapshot());
    assert_eq!(latest.load(Ordering::Relaxed), 1);
}

#[test]
fn cancellation_before_registration_fences_that_token_and_older_tokens() {
    let registry = Subscriptions::default();
    let owner = Owner::default();
    let calls = Arc::new(AtomicUsize::new(0));
    registry.unsubscribe(&owner, 5).unwrap();
    for token in [1, 4, 5] {
        assert!(registry
            .subscribe(owner.clone(), token, counter(&calls))
            .is_err());
    }
    registry
        .subscribe(owner.clone(), 6, counter(&calls))
        .unwrap()
        .commit()
        .unwrap();
    registry.publish(&snapshot());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn cancelled_discovery_rolls_back_only_its_own_registration() {
    let registry = Subscriptions::default();
    let owner = Owner::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let pending = registry
        .subscribe(owner.clone(), 1, counter(&calls))
        .unwrap();
    drop(pending);
    registry.publish(&snapshot());
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    let pending = registry
        .subscribe(owner.clone(), 2, counter(&calls))
        .unwrap();
    registry
        .subscribe(owner.clone(), 3, counter(&calls))
        .unwrap()
        .commit()
        .unwrap();
    assert!(pending.commit().is_err());
    registry.publish(&snapshot());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn failed_delivery_can_reenter_and_replace_itself_without_removing_replacement() {
    let registry = Subscriptions::default();
    let owner = Owner::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let next = counter(&calls);
    let weak = Arc::downgrade(&registry.0);
    let replaced = owner.clone();
    registry
        .subscribe(
            owner,
            1,
            Arc::new(move |_| {
                Subscriptions(weak.upgrade().unwrap())
                    .subscribe(replaced.clone(), 2, next.clone())
                    .unwrap()
                    .commit()
                    .unwrap();
                false
            }),
        )
        .unwrap()
        .commit()
        .unwrap();
    registry.publish(&snapshot());
    registry.publish(&snapshot());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn retirement_seals_delivery_and_releases_channel_without_further_requests() {
    tauri::async_runtime::block_on(async {
        struct Dropped(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let registry = Subscriptions::default();
        let owner = Owner::default();
        let (sent, received) = tokio::sync::oneshot::channel();
        let retained = Dropped(Some(sent));
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        registry
            .subscribe(
                owner.clone(),
                1,
                Arc::new(move |_| {
                    let _ = &retained;
                    observed.fetch_add(1, Ordering::Relaxed);
                    true
                }),
            )
            .unwrap()
            .commit()
            .unwrap();
        owner.retire();
        registry.publish(&snapshot());
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        tokio::time::timeout(std::time::Duration::from_secs(2), received)
            .await
            .unwrap()
            .unwrap();
    });
}

#[test]
fn capacity_counts_renderer_lifetimes_and_retirement_admits_a_replacement() {
    let registry = Subscriptions::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let owners: Vec<_> = (0..MAX_OWNERS).map(|_| Owner::default()).collect();
    for owner in &owners {
        registry
            .subscribe(owner.clone(), 1, counter(&calls))
            .unwrap()
            .commit()
            .unwrap();
    }
    let extra = Owner::default();
    assert!(registry
        .subscribe(extra.clone(), 1, counter(&calls))
        .is_err());
    // Churn consumes no extra renderer slots, including failed acknowledgements.
    for token in 2..1000 {
        drop(
            registry
                .subscribe(owners[0].clone(), token, counter(&calls))
                .unwrap(),
        );
    }
    owners[0].retire();
    registry
        .subscribe(extra, 1, counter(&calls))
        .unwrap()
        .commit()
        .unwrap();
    registry.publish(&snapshot());
    assert_eq!(calls.load(Ordering::Relaxed), MAX_OWNERS);
}

#[test]
fn invalid_tokens_do_not_consume_authority_or_capacity() {
    let registry = Subscriptions::default();
    let owner = Owner::default();
    let calls = Arc::new(AtomicUsize::new(0));
    for token in [0, i64::MAX as u64 + 1, u64::MAX] {
        assert!(registry
            .subscribe(owner.clone(), token, counter(&calls))
            .is_err());
        assert!(registry.unsubscribe(&owner, token).is_err());
    }
    registry
        .subscribe(owner.clone(), i64::MAX as u64, counter(&calls))
        .unwrap()
        .commit()
        .unwrap();
    registry.publish(&snapshot());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn retirement_breaks_transitive_application_retention_through_the_channel() {
    tauri::async_runtime::block_on(async {
        struct Dropped(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let registry = Subscriptions::default();
        let weak = Arc::downgrade(&registry.0);
        let owner = Owner::default();
        let (released, retired) = tokio::sync::oneshot::channel();
        let retained = Dropped(Some(released));
        // Tauri IPC channels capture a Webview, which can retain managed app
        // state including this registry. Model that full cycle, not just a
        // callback whose only state is a counter.
        let application = registry.clone();
        registry
            .subscribe(
                owner.clone(),
                1,
                Arc::new(move |_| {
                    let _ = (&application, &retained);
                    true
                }),
            )
            .unwrap()
            .commit()
            .unwrap();
        drop(registry);
        owner.retire();
        tokio::time::timeout(std::time::Duration::from_secs(2), retired)
            .await
            .unwrap()
            .unwrap();
        // Callback drop precedes the retirement task's final registry release.
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    });
}
