#![cfg(target_os = "linux")]
//! The FileChooser portal backend's process lifetime against the real binary on
//! an isolated session bus with private XDG roots (#1427): it exits once idle,
//! a request postpones that, a second backend that cannot own the bus name does
//! not linger, and a live backend never holds the plugin profile.
//!
//! GTK needs an X display, so these are opt-in: `bun run test:portal-lifecycle`
//! (`xvfb-run -a cargo test --test portal_lifecycle -- --ignored`).
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

const NAME: &str = "org.freedesktop.impl.portal.desktop.tauri_explorer";
const IDLE: Duration = Duration::from_secs(4);
/// Debug-build cold start under a loaded host, and exit after the idle delay.
const STARTUP: Duration = Duration::from_secs(60);
const EXIT_SLACK: Duration = Duration::from_secs(20);

const BUS_CONFIG: &str = r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"#;

struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Session {
    _daemon: Owned,
    address: String,
    xdg: tempfile::TempDir,
}

fn session() -> Session {
    assert!(
        std::env::var_os("DISPLAY").is_some(),
        "run under xvfb-run: GTK needs an X display"
    );
    let xdg = tempfile::tempdir().unwrap();
    for dir in ["config", "data", "cache", "runtime"] {
        std::fs::create_dir(xdg.path().join(dir)).unwrap();
    }
    std::fs::set_permissions(
        xdg.path().join("runtime"),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    // No service directories: nothing on this bus may be activated, so neither
    // an installed backend nor the host's portal services can stand in.
    let config = xdg.path().join("bus.conf");
    std::fs::write(&config, BUS_CONFIG).unwrap();
    let mut daemon = Command::new("dbus-daemon")
        .arg(format!("--config-file={}", config.display()))
        .args(["--nofork", "--print-address=1"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut address = String::new();
    BufReader::new(daemon.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    Session {
        _daemon: Owned(daemon),
        address: address.trim().to_owned(),
        xdg,
    }
}

impl Session {
    fn portal(&self) -> Owned {
        let root = self.xdg.path();
        Owned(
            Command::new(env!("CARGO_BIN_EXE_tauri-explorer"))
                .arg("--file-chooser-portal")
                .env("DBUS_SESSION_BUS_ADDRESS", &self.address)
                .env("XDG_CONFIG_HOME", root.join("config"))
                .env("XDG_DATA_HOME", root.join("data"))
                .env("XDG_CACHE_HOME", root.join("cache"))
                .env("XDG_RUNTIME_DIR", root.join("runtime"))
                .env(
                    "TAURI_EXPLORER_PORTAL_IDLE_MS",
                    IDLE.as_millis().to_string(),
                )
                // Never reach the developer's own compositor.
                .env("GDK_BACKEND", "x11")
                .env_remove("WAYLAND_DISPLAY")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }

    async fn bus(&self) -> zbus::Connection {
        zbus::connection::Builder::address(self.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap()
    }

    /// What a normal explorer instance takes at startup: the profile's lease.
    fn plugin_profile_is_free(&self) -> bool {
        let profile = self.xdg.path().join("config").join("tauri-explorer");
        std::fs::create_dir_all(&profile).unwrap();
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(profile.join(".plugin-runtime.lock"))
            .unwrap();
        lease.try_lock().is_ok()
    }
}

async fn owned(bus: &zbus::Connection) -> bool {
    zbus::fdo::DBusProxy::new(bus)
        .await
        .unwrap()
        .name_has_owner(NAME.try_into().unwrap())
        .await
        .unwrap()
}

async fn wait_owned(bus: &zbus::Connection, portal: &mut Owned) -> Instant {
    let deadline = Instant::now() + STARTUP;
    while !owned(bus).await {
        assert!(
            portal.0.try_wait().unwrap().is_none(),
            "portal exited before owning its name"
        );
        assert!(Instant::now() < deadline, "portal never owned {NAME}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Instant::now()
}

async fn exit_within(portal: &mut Owned, limit: Duration) -> ExitStatus {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = portal.0.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "portal still running");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn alive(portal: &mut Owned) -> bool {
    portal.0.try_wait().unwrap().is_none()
}

#[tokio::test]
#[ignore = "needs an X display (xvfb-run) and dbus-daemon"]
async fn an_idle_portal_without_requests_releases_its_name_and_exits() {
    let session = session();
    let bus = session.bus().await;
    let mut portal = session.portal();
    wait_owned(&bus, &mut portal).await;
    // The explorer can own its plugin profile while the portal is alive.
    assert!(session.plugin_profile_is_free());
    assert!(alive(&mut portal));
    let status = exit_within(&mut portal, IDLE + EXIT_SLACK).await;
    assert!(status.success(), "{status}");
    assert!(!owned(&bus).await);
}

#[tokio::test]
#[ignore = "needs an X display (xvfb-run) and dbus-daemon"]
async fn a_request_postpones_the_idle_exit() {
    let session = session();
    let bus = session.bus().await;
    let mut portal = session.portal();
    let ready = wait_owned(&bus, &mut portal).await;
    tokio::time::sleep(IDLE / 2).await;
    // SaveFiles answers immediately without a window: activity, no dialog.
    let reply = bus
        .call_method(
            Some(NAME),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.impl.portal.FileChooser"),
            "SaveFiles",
            &(
                zbus::zvariant::ObjectPath::try_from("/org/freedesktop/portal/desktop/request/1/t")
                    .unwrap(),
                "test",
                "",
                "Save",
                std::collections::HashMap::<&str, zbus::zvariant::Value>::new(),
            ),
        )
        .await
        .unwrap();
    let (code, _): (
        u32,
        std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
    ) = reply.body().deserialize().unwrap();
    assert_eq!(code, 1);
    let requested = Instant::now();
    // Past the startup deadline, still inside the one the request armed.
    let check = ready + IDLE + Duration::from_millis(1500);
    tokio::time::sleep(check.saturating_duration_since(Instant::now())).await;
    assert!(requested + IDLE > Instant::now() + Duration::from_millis(500));
    assert!(
        alive(&mut portal),
        "exited on the timer armed before the request"
    );
    assert!(owned(&bus).await);
    let status = exit_within(&mut portal, IDLE + EXIT_SLACK).await;
    assert!(status.success(), "{status}");
}

#[tokio::test]
#[ignore = "needs an X display (xvfb-run) and dbus-daemon"]
async fn a_backend_that_cannot_own_the_name_exits_instead_of_lingering() {
    let session = session();
    let bus = session.bus().await;
    let mut first = session.portal();
    wait_owned(&bus, &mut first).await;
    let mut second = session.portal();
    // Well before the idle delay could apply: it never served anything.
    let status = exit_within(&mut second, STARTUP).await;
    assert!(!status.success(), "{status}");
    assert!(alive(&mut first));
}
