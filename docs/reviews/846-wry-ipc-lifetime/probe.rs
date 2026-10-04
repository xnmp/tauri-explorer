use gtk::prelude::*;
use std::{cell::Cell, fs, path::Path, rc::Rc, thread, time::{Duration, Instant}};
use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtUnix};

fn drain_for(duration: Duration) {
    let deadline = Instant::now() + duration;
    let context = gtk::glib::MainContext::default();
    while Instant::now() < deadline {
        while context.pending() { context.iteration(false); }
        thread::sleep(Duration::from_millis(1));
    }
}
fn shared_fds() -> usize {
    fs::read_dir("/proc/self/fd").unwrap().flatten()
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .filter(|target| target.to_string_lossy().contains("WebKitSharedMemory"))
        .count()
}
fn open(context: &mut WebContext, count: Rc<Cell<usize>>) -> (gtk::Window, WebView, gtk::glib::WeakRef<gtk::Widget>) {
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_default_size(400, 240);
    let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
    window.add(&container);
    window.show_all();
    let register = !context.is_custom_protocol_registered("probe");
    let mut builder = WebViewBuilder::new_with_web_context(context)
        .with_ipc_handler(move |_| count.set(count.get() + 1))
        .with_url("probe://localhost/");
    if register {
        builder = builder.with_custom_protocol("probe".into(), |_, _| {
            wry::http::Response::builder().header("Content-Type", "text/html")
                .body(b"<!doctype html><body style='background:#6ba;color:black'><h1>IPC lifetime probe</h1><script>requestAnimationFrame(()=>requestAnimationFrame(()=>window.ipc.postMessage('painted')))</script>".to_vec()).unwrap().map(Into::into)
        });
    }
    let view = builder.build_gtk(&container).unwrap();
    let children = container.children();
    assert_eq!(children.len(), 1, "expected the actual Wry WebView widget");
    let weak_view = children[0].downgrade();
    (window, view, weak_view)
}
fn wait_count(count: &Cell<usize>, target: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while count.get() < target && Instant::now() < deadline { drain_for(Duration::from_millis(2)); }
    assert!(count.get() >= target, "live IPC did not arrive");
}
fn main() {
    assert!(std::env::var("DISPLAY").unwrap().starts_with(':'));
    assert_eq!(std::env::var("GDK_BACKEND").unwrap(), "x11");
    assert!(std::env::var_os("WAYLAND_DISPLAY").is_none());
    gtk::init().unwrap();
    let mut context = WebContext::new(None);
    let main_count = Rc::new(Cell::new(0));
    let (main_window, main_view, _main_weak) = open(&mut context, main_count.clone());
    wait_count(&main_count, 1);
    fs::write(std::env::var("PROBE_READY").unwrap(), std::process::id().to_string()).unwrap();
    let gate = std::env::var("PROBE_GO").unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !Path::new(&gate).exists() {
        assert!(Instant::now() < deadline, "environment verification gate timed out");
        drain_for(Duration::from_millis(10));
    }
    drain_for(Duration::from_millis(100));
    let baseline = shared_fds();
    assert!(baseline > 0, "fixture did not exercise painted WebKit shared-memory descriptors");
    let mut maximum = baseline;
    println!("pid={} baseline_shared_fds={baseline}", std::process::id());
    for cycle in 1..=450 {
        let child_count = Rc::new(Cell::new(0));
        let (child, view, weak_view) = open(&mut context, child_count.clone());
        wait_count(&child_count, 1);
        unsafe { child.destroy(); }
        drop(view);
        drop(child);
        drain_for(Duration::from_millis(25));
        // GWeakRef clears at GTK disposal; it does not prove finalization.
        // Shared-memory descriptors below detect retained native resources.
        assert!(weak_view.upgrade().is_none(), "cycle {cycle}: destroyed WebView GObject is still retained");
        let fds = shared_fds();
        maximum = maximum.max(fds);
        assert!(fds <= baseline + 16, "cycle {cycle}: shared fds grew {baseline} -> {fds}");
        if cycle % 25 == 0 { println!("cycle={cycle} shared_fds={fds}"); }
    }
    main_view.evaluate_script("window.ipc.postMessage('after-churn')").unwrap();
    wait_count(&main_count, 2);
    drain_for(Duration::from_millis(250));
    println!("PASS cycles=450 live_child_ipcs=450 disposed_child_widgets=450 main_ipcs={} baseline_shared_fds={baseline} final_shared_fds={} maximum_shared_fds={maximum}", main_count.get(), shared_fds());
    unsafe { main_window.destroy(); }
    drop(main_view);
    drain_for(Duration::from_millis(100));
}
