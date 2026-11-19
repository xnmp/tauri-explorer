//! Shared bounded `ureq` agent for small JSON requests (update manifest,
//! GitHub PR lookups). A stalled server must fail the call instead of
//! pinning a blocking worker (and its caller) forever (#1597).
//!
//! The report relay, avatar and fal paths set their own deliberate timeouts.

use std::time::Duration;

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const OVERALL_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn bounded_agent() -> ureq::Agent {
    bounded_agent_with(CONNECT_TIMEOUT, OVERALL_TIMEOUT)
}

pub(crate) fn bounded_agent_with(connect: Duration, overall: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(connect))
        .timeout_global(Some(overall))
        .build()
        .into()
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::thread::JoinHandle;

    /// A server that accepts connections and never answers. Dropping the
    /// guard stops it and releases the held sockets.
    pub(crate) struct StalledServer {
        pub(crate) addr: SocketAddr,
        _thread: JoinHandle<()>,
        _stop: std::sync::mpsc::Sender<()>,
    }

    pub(crate) fn stalled_server() -> StalledServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let thread = std::thread::spawn(move || {
            let mut held: Vec<TcpStream> = Vec::new();
            listener.set_nonblocking(true).unwrap();
            while stopped.try_recv() == Err(std::sync::mpsc::TryRecvError::Empty) {
                if let Ok((stream, _)) = listener.accept() {
                    held.push(stream);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
        StalledServer {
            addr,
            _thread: thread,
            _stop: stop,
        }
    }
}
