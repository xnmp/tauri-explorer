//! Opt-in native admission barrier. The real history executor is unchanged;
//! the external runner releases accepted work independently of its renderer.
//! This module and its environment lookup are absent from ordinary builds.
use super::model::{Direction, EntryId};
use std::{
    fs, io,
    path::Path,
    time::{Duration, Instant},
};

#[derive(serde::Deserialize)]
struct Request {
    token: String,
}

fn publish(path: &Path, value: serde_json::Value) -> io::Result<()> {
    let pending = path.with_extension("pending");
    fs::write(&pending, serde_json::to_vec(&value)?)?;
    fs::rename(pending, path)
}

pub(super) async fn after_admission(entry_id: EntryId, direction: Direction) -> Result<(), String> {
    let Some(directory) = std::env::var_os("TAURI_E2E_HISTORY_GATE_DIR") else {
        return Ok(());
    };
    // All filesystem polling belongs to an opt-in blocking worker, never the
    // history lock, UI thread, or async runtime worker.
    tauri::async_runtime::spawn_blocking(move || -> io::Result<()> {
        let directory = Path::new(&directory);
        let direction = match direction { Direction::Undo => "undo", Direction::Redo => "redo" };
        let stem = format!("{entry_id}-{direction}");
        let request = match fs::read(directory.join(format!("{stem}.arm"))) {
            Ok(bytes) => serde_json::from_slice::<Request>(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if request.token.is_empty() || request.token.len() > 128 || !request.token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid history gate token"));
        }
        fs::remove_file(directory.join(format!("{stem}.arm")))?;
        publish(&directory.join(format!("{stem}.accepted.json")), serde_json::json!({
            "token": request.token, "entryId": entry_id, "direction": direction, "pid": std::process::id(),
        }))?;
        let release = directory.join(format!("{stem}.{}.release", request.token));
        let started = Instant::now();
        let released = loop {
            match fs::read_to_string(&release) {
                Ok(token) if token == request.token => break true,
                Ok(_) => return Err(io::Error::new(io::ErrorKind::InvalidData, "History release token mismatch")),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                Err(error) => return Err(error),
            }
            if started.elapsed() >= Duration::from_secs(60) { break false; }
            std::thread::sleep(Duration::from_millis(10));
        };
        publish(&directory.join(format!("{stem}.released.json")), serde_json::json!({
            "token": request.token, "status": if released { "released" } else { "timeout" },
        }))?;
        if released { Ok(()) } else {
            Err(io::Error::new(io::ErrorKind::TimedOut, "History admission gate was not released"))
        }
    }).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}
