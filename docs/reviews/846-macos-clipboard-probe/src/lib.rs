//! Isolated provider probe: every tested implementation comes from the app.
// The app normally consumes APIs unused by this deliberately narrow crate.
#![allow(dead_code, unused_imports)]

pub mod clipboard;
#[path = "../../../../src-tauri/src/error.rs"]
pub mod error;
