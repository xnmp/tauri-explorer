//! Long-lived UDisks2 subscription behind removable-volume discovery (#888).
//!
//! One system-bus connection is kept per process. The worker subscribes to the
//! ObjectManager `InterfacesAdded`/`InterfacesRemoved` signals, every object's
//! `PropertiesChanged`, and the service's `NameOwnerChanged`, applying each
//! signal to a cached `GetManagedObjects` snapshot (the approach GIO's
//! `GDBusObjectManagerClient`, used by udisks and GVfs clients, takes). The
//! derived volume list is published through a watch channel, and every change
//! to it calls the notifier. A slow backstop resync corrects any missed signal.
//!
//! Without a system bus or UDisks, discovery reports `Unavailable` and callers
//! keep mount-table discovery (ADR 0025). The worker retries the connection,
//! and a returning service is picked up from `NameOwnerChanged`.
use super::linux_volumes::{fetch_objects, volumes, Volume, ROOT, SERVICE};
use crate::error::AppError;
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};
use zbus::{
    export::futures_core::Stream,
    fdo::ManagedObjects,
    message::Type,
    names::OwnedInterfaceName,
    zvariant::{OwnedObjectPath, OwnedValue},
    Connection, Message, MessageStream,
};

/// UDisks-backed discovery as last observed by the subscription.
#[derive(Debug, Clone, PartialEq)]
pub enum Discovery {
    /// The first snapshot has not been attempted yet.
    Pending,
    /// No system bus or no UDisks service: use mount-table discovery only.
    Unavailable,
    /// Subscribed; the eligible volumes of the current snapshot.
    Live(Arc<Vec<Volume>>),
}

#[derive(Debug, Clone, Copy)]
pub struct MonitorConfig {
    /// Resync period that corrects any change a signal failed to describe.
    pub backstop: Duration,
    /// Delay before reconnecting after the system bus was unreachable or lost.
    pub retry: Duration,
    /// How long a caller waits for the first snapshot after startup.
    pub first_sync: Duration,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            backstop: Duration::from_secs(30),
            retry: Duration::from_secs(5),
            // Connection and discovery each have a two-second deadline.
            first_sync: Duration::from_millis(4_500),
        }
    }
}

type ConnectFuture = Pin<Box<dyn Future<Output = Result<Connection, AppError>> + Send>>;
type Connector = Arc<dyn Fn() -> ConnectFuture + Send + Sync>;
/// Called with `true` while subscribed (Live) and `false` after falling back.
type Notifier = Arc<dyn Fn(bool) + Send + Sync>;
type ConnectionSlot = Arc<Mutex<Option<Connection>>>;

struct Worker {
    connect: Connector,
    notify: Notifier,
    config: MonitorConfig,
    publish: watch::Sender<Discovery>,
    slot: ConnectionSlot,
    requests: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
}

/// Owns the subscription worker. The worker starts on first use, inside the
/// caller's async runtime, and stops when the monitor is dropped.
pub struct VolumeMonitor {
    state: watch::Receiver<Discovery>,
    slot: ConnectionSlot,
    requests: mpsc::UnboundedSender<oneshot::Sender<()>>,
    config: MonitorConfig,
    unstarted: Mutex<Option<Worker>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl VolumeMonitor {
    pub fn new<C, F, N>(config: MonitorConfig, connect: C, notify: N) -> Self
    where
        C: Fn() -> F + Send + Sync + 'static,
        F: Future<Output = Result<Connection, AppError>> + Send + 'static,
        N: Fn(bool) + Send + Sync + 'static,
    {
        let (publish, state) = watch::channel(Discovery::Pending);
        let (requests, receiver) = mpsc::unbounded_channel();
        let slot = ConnectionSlot::default();
        let worker = Worker {
            connect: Arc::new(move || Box::pin(connect()) as ConnectFuture),
            notify: Arc::new(notify),
            config,
            publish,
            slot: slot.clone(),
            requests: receiver,
        };
        Self {
            state,
            slot,
            requests,
            config,
            unstarted: Mutex::new(Some(worker)),
            task: Mutex::new(None),
        }
    }

    /// Spawns the worker on first use. Every public method runs inside a Tokio
    /// runtime (Tauri's async commands, or `#[tokio::test]`).
    fn ensure_started(&self) {
        let worker = self
            .unstarted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            *self.task.lock().unwrap_or_else(PoisonError::into_inner) =
                Some(tokio::spawn(worker.run()));
        }
    }

    /// The cached discovery, waiting (bounded) only for the very first snapshot.
    /// Never opens a connection or queries the bus itself.
    pub async fn discovery(&self) -> Discovery {
        self.ensure_started();
        let mut state = self.state.clone();
        let first = async {
            state
                .wait_for(|d| *d != Discovery::Pending)
                .await
                .map(|discovery| discovery.clone())
        };
        match tokio::time::timeout(self.config.first_sync, first).await {
            Ok(Ok(discovery)) => discovery,
            _ => Discovery::Unavailable,
        }
    }

    /// Whether drive changes are currently pushed from a live subscription.
    pub fn is_live(&self) -> bool {
        self.ensure_started();
        matches!(*self.state.borrow(), Discovery::Live(_))
    }

    /// The subscription's connection, for mount requests on the same bus.
    pub fn connection(&self) -> Option<Connection> {
        self.ensure_started();
        self.slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Resynchronize now and wait for the result to be published, so a caller
    /// that just changed mount state reads it back without waiting for signals.
    pub async fn resync(&self) {
        self.ensure_started();
        let (ack, done) = oneshot::channel();
        if self.requests.send(ack).is_ok() {
            let _ = tokio::time::timeout(self.config.first_sync, done).await;
        }
    }
}

impl Drop for VolumeMonitor {
    fn drop(&mut self) {
        if let Some(task) = self
            .task
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }
}

enum SessionEnd {
    Disconnected,
    Shutdown,
}

impl Worker {
    async fn run(mut self) {
        loop {
            if let Ok(connection) = (self.connect)().await {
                self.set_slot(Some(connection.clone()));
                let end = self.session(&connection).await;
                self.set_slot(None);
                if let SessionEnd::Shutdown = end {
                    return;
                }
            }
            self.publish(None);
            if !self.idle(self.config.retry).await {
                return;
            }
        }
    }

    fn set_slot(&self, connection: Option<Connection>) {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = connection;
    }

    /// Wait before reconnecting. Resync requests cannot reach a bus meanwhile,
    /// so they are acknowledged immediately. Returns false on shutdown.
    async fn idle(&mut self, delay: Duration) -> bool {
        let deadline = tokio::time::sleep(delay);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => return true,
                request = self.requests.recv() => match request {
                    Some(ack) => { let _ = ack.send(()); }
                    None => return false,
                },
            }
        }
    }

    async fn session(&mut self, connection: &Connection) -> SessionEnd {
        // Subscribe before the first snapshot so no change falls between them.
        let (Ok(mut signals), Ok(mut owners)) = (
            MessageStream::for_match_rule(udisks_signals_rule(), connection, None).await,
            MessageStream::for_match_rule(service_owner_rule(), connection, None).await,
        ) else {
            return SessionEnd::Disconnected;
        };
        let mut cache = match fetch(connection).await {
            Fetched::Objects(objects) => Some(objects),
            Fetched::ServiceMissing => None,
            Fetched::Disconnected => return SessionEnd::Disconnected,
        };
        self.publish(cache.as_ref());
        let period = self.config.backstop;
        let mut backstop = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        // A slow refetch must not queue a burst of catch-up refetches.
        backstop.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let mut ack = None;
            let resync = tokio::select! {
                message = next(&mut signals) => match message {
                    Some(Ok(message)) => !cache
                        .as_mut()
                        .is_some_and(|objects| apply_signal(objects, &message)),
                    _ => return SessionEnd::Disconnected,
                },
                message = next(&mut owners) => match message {
                    Some(Ok(message)) if service_has_owner(&message) => true,
                    Some(Ok(_)) => {
                        // The service exited; its objects left with it.
                        cache = None;
                        false
                    }
                    _ => return SessionEnd::Disconnected,
                },
                _ = backstop.tick() => true,
                request = self.requests.recv() => match request {
                    Some(request) => {
                        ack = Some(request);
                        true
                    }
                    None => return SessionEnd::Shutdown,
                },
            };
            if resync {
                cache = match fetch(connection).await {
                    Fetched::Objects(objects) => Some(objects),
                    Fetched::ServiceMissing => None,
                    Fetched::Disconnected => return SessionEnd::Disconnected,
                };
            }
            self.publish(cache.as_ref());
            if let Some(ack) = ack {
                let _ = ack.send(());
            }
        }
    }

    /// Publish the volumes derived from `objects` and notify only when they
    /// differ, so unrelated property churn (SMART data, drive stats) is silent.
    fn publish(&self, objects: Option<&ManagedObjects>) {
        let next = match objects {
            Some(objects) => Discovery::Live(Arc::new(volumes(objects))),
            None => Discovery::Unavailable,
        };
        let live = matches!(next, Discovery::Live(_));
        let changed = self.publish.send_if_modified(|current| {
            let changed = *current != next;
            if changed {
                *current = next;
            }
            changed
        });
        if changed {
            (self.notify)(live);
        }
    }
}

async fn next(stream: &mut MessageStream) -> Option<zbus::Result<Message>> {
    std::future::poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)).await
}

enum Fetched {
    Objects(ManagedObjects),
    ServiceMissing,
    Disconnected,
}

async fn fetch(connection: &Connection) -> Fetched {
    match fetch_objects(connection).await {
        Ok(objects) => Fetched::Objects(objects),
        // A socket failure ends this connection; anything else (no owner,
        // activation failure, timeout) leaves the bus usable for the next event.
        Err(zbus::Error::InputOutput(_)) => Fetched::Disconnected,
        Err(_) => Fetched::ServiceMissing,
    }
}

fn udisks_signals_rule() -> zbus::MatchRule<'static> {
    zbus::MatchRule::builder()
        .msg_type(Type::Signal)
        .sender(SERVICE)
        .and_then(|rule| rule.path_namespace(ROOT))
        .map(|rule| rule.build())
        .expect("static UDisks match rule is valid")
}

fn service_owner_rule() -> zbus::MatchRule<'static> {
    zbus::MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.DBus")
        .and_then(|rule| rule.interface("org.freedesktop.DBus"))
        .and_then(|rule| rule.member("NameOwnerChanged"))
        .and_then(|rule| rule.add_arg(SERVICE))
        .map(|rule| rule.build())
        .expect("static NameOwnerChanged match rule is valid")
}

fn service_has_owner(message: &Message) -> bool {
    message
        .body()
        .deserialize::<(String, String, String)>()
        .is_ok_and(|(_, _, owner)| !owner.is_empty())
}

type Interfaces = HashMap<OwnedInterfaceName, HashMap<String, OwnedValue>>;

/// Apply one UDisks signal to the cached objects. Returns false when the signal
/// cannot be applied exactly and the cache must be refetched instead.
fn apply_signal(objects: &mut ManagedObjects, message: &Message) -> bool {
    let header = message.header();
    let interface = header.interface().map(|name| name.as_str());
    let member = header.member().map(|name| name.as_str());
    let body = message.body();
    match (interface, member) {
        (Some("org.freedesktop.DBus.ObjectManager"), Some("InterfacesAdded")) => {
            let Ok((path, added)) = body.deserialize::<(OwnedObjectPath, Interfaces)>() else {
                return false;
            };
            // Each added interface arrives with its complete property set.
            objects.entry(path).or_default().extend(added);
            true
        }
        (Some("org.freedesktop.DBus.ObjectManager"), Some("InterfacesRemoved")) => {
            let Ok((path, removed)) =
                body.deserialize::<(OwnedObjectPath, Vec<OwnedInterfaceName>)>()
            else {
                return false;
            };
            if let Some(interfaces) = objects.get_mut(&path) {
                for interface in &removed {
                    interfaces.remove(interface);
                }
                if interfaces.is_empty() {
                    objects.remove(&path);
                }
            }
            true
        }
        (Some("org.freedesktop.DBus.Properties"), Some("PropertiesChanged")) => {
            let Some(path) = header.path() else {
                return false;
            };
            let Ok((interface, changed, invalidated)) =
                body.deserialize::<(OwnedInterfaceName, HashMap<String, OwnedValue>, Vec<String>)>(
                )
            else {
                return false;
            };
            // Invalidated values carry no data; unknown objects mean the cache
            // missed an addition. Both need a fresh snapshot.
            if !invalidated.is_empty() {
                return false;
            }
            match objects
                .get_mut(path)
                .and_then(|interfaces| interfaces.get_mut(&interface))
            {
                Some(properties) => {
                    properties.extend(changed);
                    true
                }
                None => false,
            }
        }
        // Other UDisks signals (job progress, etc.) do not change the objects.
        _ => true,
    }
}
