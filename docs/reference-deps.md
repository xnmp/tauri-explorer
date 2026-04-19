# Reference: Key Rust Dependencies

Quick API reference for non-obvious Rust dependencies used in this project.

---

## jwalk `0.8` — Parallel Directory Walking

Used in: `search.rs` for recursive file search.

```rust
use jwalk::WalkDir;

// Basic recursive walk
for entry in WalkDir::new("/path") {
    let entry = entry?;
    println!("{}", entry.path().display());
}

// With options
let walker = WalkDir::new("/path")
    .skip_hidden(false)     // include hidden files
    .follow_links(false)    // don't follow symlinks
    .min_depth(1)           // skip root
    .max_depth(5)           // limit depth
    .sort(true);            // sort entries

// Parallelism: jwalk uses Rayon internally (default thread pool).
// Entries stream in parallel — no need to manually parallelize.
```

**Key behaviors:**
- Returns `DirEntry` with `.path()`, `.file_name()`, `.file_type()`, `.metadata()`
- Errors are per-entry (I/O errors don't stop the walk)
- Thread-safe: can collect into `Vec` or process in parallel

---

## grep-searcher `0.1` + grep-regex `0.1` — Content Search

Used in: `content_search.rs` for ripgrep-based file content search.

```rust
use grep_regex::RegexMatcher;
use grep_searcher::{Searcher, Sink, SinkMatch};

let matcher = RegexMatcher::new(r"pattern")?;

// Create searcher (reuse per thread — allocates internal buffers)
let mut searcher = Searcher::new();

// Search a file
searcher.search_path(&matcher, "/path/to/file", MySink)?;

// Custom sink to collect matches
struct MySink { matches: Vec<(u64, String)> }

impl Sink for MySink {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch) -> Result<bool, Self::Error> {
        let line_number = mat.line_number().unwrap_or(0);
        let text = String::from_utf8_lossy(mat.bytes()).to_string();
        self.matches.push((line_number, text));
        Ok(true) // continue searching
    }
}
```

**Key behaviors:**
- `Searcher::new()` allocates buffers — create once per thread, not per file
- `RegexMatcher` supports case-insensitive via `RegexMatcherBuilder::new().case_insensitive(true)`
- Binary files are skipped by default (configurable via `SearcherBuilder`)

---

## fs_extra `1.3` — Advanced File Operations

Used in: `file_ops.rs` for copy/move with options.

```rust
use fs_extra::dir::{copy as copy_dir, CopyOptions as DirCopyOptions};
use fs_extra::file::{copy as copy_file, CopyOptions as FileCopyOptions};

// Copy directory recursively
let mut opts = DirCopyOptions::new();
opts.overwrite = true;     // overwrite existing files
opts.copy_inside = true;   // copy contents into dest (not as subdir)
copy_dir("/src", "/dst", &opts)?;

// Copy single file
let mut opts = FileCopyOptions::new();
opts.overwrite = true;
copy_file("/src/file.txt", "/dst/file.txt", &opts)?;

// Move directory
use fs_extra::dir::move_dir;
move_dir("/src", "/dst", &DirCopyOptions::new())?;
```

**Key behaviors:**
- `copy_inside = true` means copy contents of `/src` INTO `/dst`, not create `/dst/src`
- Returns `u64` (bytes copied)
- Errors are `fs_extra::error::Error` (wraps `std::io::Error`)

---

## image `0.25` — Image Processing

Used in: `thumbnails.rs` for generating thumbnail previews.

```rust
use image::{ImageReader, DynamicImage, imageops::FilterType};

// Open and decode
let img: DynamicImage = ImageReader::open("photo.jpg")?
    .with_guessed_format()?
    .decode()?;

// Resize (preserving aspect ratio)
let thumb = img.resize(128, 128, FilterType::Triangle);

// Resize exact (ignoring aspect ratio)
let thumb = img.resize_exact(128, 128, FilterType::Triangle);

// Save as JPEG with quality
use image::codecs::jpeg::JpegEncoder;
let mut buf = Vec::new();
let encoder = JpegEncoder::new_with_quality(&mut buf, 85);
thumb.write_with_encoder(encoder)?;

// Save as PNG
thumb.save("thumb.png")?;
```

**Filter types:** `Nearest` (fastest), `Triangle` (bilinear, good quality/speed), `Lanczos3` (highest quality, slowest).

**Enabled features in this project:** jpeg, png, gif, webp, bmp.

---

## tauri-plugin-log `2` — Structured Logging

Used in: `lib.rs` for application logging.

```rust
// In lib.rs setup
use tauri_plugin_log::{Target, TargetKind};

app.plugin(
    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: None }),
        ])
        .level(log::LevelFilter::Info)
        .build(),
)?;

// Anywhere in Rust code
log::info!("Navigated to {}", path);
log::warn!("Slow directory scan: {}ms", elapsed);
log::error!("Failed to read {}: {}", path, err);
```

**Frontend (JS):**
```ts
import { info, warn, error } from "@tauri-apps/plugin-log";
await info("Message from frontend");
```

**Log levels:** `error`, `warn`, `info`, `debug`, `trace` (filtered by `.level()` setting).
