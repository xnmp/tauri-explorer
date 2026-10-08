//! `file://` URI lists as Linux file managers exchange them
//! (`text/uri-list`, `x-special/gnome-copied-files`).

/// Parse `file://` URIs into filesystem paths.
pub(super) fn parse_file_uris(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let trimmed = line.trim().trim_end_matches('\0');
            trimmed.strip_prefix("file://").map(percent_decode)
        })
        .collect()
}

/// Minimal percent-decoding for file paths.
/// Decodes to raw bytes first, then interprets the whole result as UTF-8 so
/// multi-byte sequences (e.g. %C3%A9 -> é) aren't mangled byte-by-byte.
fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut iter = input.bytes();
    while let Some(b) = iter.next() {
        if b == b'%' {
            let hi = iter.next();
            let lo = iter.next();
            if let (Some(hi), Some(lo)) = (hi, lo) {
                let hex = [hi, lo];
                if let Ok(s) = std::str::from_utf8(&hex) {
                    if let Ok(byte) = u8::from_str_radix(s, 16) {
                        bytes.push(byte);
                        continue;
                    }
                }
                // Malformed %-sequence, emit literally
                bytes.push(b'%');
                bytes.push(hi);
                bytes.push(lo);
            } else {
                bytes.push(b'%');
                bytes.extend(hi);
                bytes.extend(lo);
            }
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Percent-encode a file path for use in `file://` URIs.
fn percent_encode_path(path: &str) -> String {
    let mut result = String::with_capacity(path.len() * 2);
    for b in path.bytes() {
        match b {
            // Unreserved characters (RFC 3986) + '/' (path separator)
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                result.push(b as char);
            }
            _ => {
                result.push('%');
                result.push_str(&format!("{:02X}", b));
            }
        }
    }
    result
}

/// Build file URIs from paths.
pub(super) fn paths_to_uris(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|p| format!("file://{}", percent_encode_path(p)))
        .collect()
}

/// Paths from an `x-special/gnome-copied-files` payload, whose first line is
/// the `copy`/`cut` verb and the rest are URIs.
pub(super) fn parse_gnome_copied_files(text: &str) -> Vec<String> {
    let uris = text.lines().skip(1).collect::<Vec<_>>().join("\n");
    parse_file_uris(&uris)
}

/// An `x-special/gnome-copied-files` payload for `uris`. Every mirror is
/// advertised as `copy`: only the app's own paste may consume its Cut, so an
/// external file manager must never move files the app has cut.
pub(super) fn gnome_copied_files(uris: &[String]) -> String {
    format!("copy\n{}", uris.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_uri_list() {
        let input = "file:///home/user/doc.txt\nfile:///home/user/image.png\n";
        let paths = parse_file_uris(input);
        assert_eq!(paths, vec!["/home/user/doc.txt", "/home/user/image.png"]);
    }

    #[test]
    fn parse_uri_list_with_comments() {
        let input = "# comment\nfile:///tmp/test.txt\n";
        let paths = parse_file_uris(input);
        assert_eq!(paths, vec!["/tmp/test.txt"]);
    }

    #[test]
    fn parse_gnome_format() {
        let raw = "copy\nfile:///home/user/doc.txt\nfile:///home/user/pic.jpg";
        assert_eq!(
            parse_gnome_copied_files(raw),
            vec!["/home/user/doc.txt", "/home/user/pic.jpg"]
        );
        assert!(parse_gnome_copied_files("cut").is_empty());
        assert!(parse_gnome_copied_files("").is_empty());
    }

    #[test]
    fn gnome_payload_round_trips_and_is_always_copy() {
        let paths = vec!["/tmp/a b.txt".to_string(), "/tmp/é#1.txt".to_string()];
        let payload = gnome_copied_files(&paths_to_uris(&paths));
        assert!(payload.starts_with("copy\n"), "{payload}");
        assert_eq!(parse_gnome_copied_files(&payload), paths);
    }

    #[test]
    fn parse_percent_encoded_path() {
        let input = "file:///home/user/My%20Documents/file%23name.txt\n";
        let paths = parse_file_uris(input);
        assert_eq!(paths, vec!["/home/user/My Documents/file#name.txt"]);
    }

    #[test]
    fn parse_empty_input() {
        assert!(parse_file_uris("").is_empty());
        assert!(parse_file_uris("\n\n").is_empty());
    }

    #[test]
    fn parse_non_file_uris_ignored() {
        let input = "http://example.com\nfile:///tmp/ok.txt\n";
        let paths = parse_file_uris(input);
        assert_eq!(paths, vec!["/tmp/ok.txt"]);
    }

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("/path/to/file"), "/path/to/file");
        assert_eq!(percent_decode("/path%20with%20spaces"), "/path with spaces");
        assert_eq!(percent_decode("%2Ftmp%2Ftest"), "/tmp/test");
    }

    #[test]
    fn percent_decode_keeps_malformed_sequences_literally() {
        assert_eq!(percent_decode("/a%zzb"), "/a%zzb");
        assert_eq!(percent_decode("/trailing%2"), "/trailing%2");
        assert_eq!(percent_decode("/trailing%"), "/trailing%");
    }

    #[test]
    fn percent_decode_utf8_multibyte() {
        // %C3%A9 = é (2 bytes), %E6%97%A5 = 日 (3 bytes)
        assert_eq!(percent_decode("/home/user/%C3%A9t%C3%A9"), "/home/user/été");
        assert_eq!(
            percent_decode("/tmp/%E6%97%A5%E6%9C%AC.txt"),
            "/tmp/日本.txt"
        );
    }

    #[test]
    fn percent_decode_utf8_roundtrip() {
        let original = "/home/user/Téléchargements/файл 日本.png";
        let encoded = percent_encode_path(original);
        assert_eq!(percent_decode(&encoded), original);
    }

    #[test]
    fn percent_encode_path_basic() {
        assert_eq!(
            percent_encode_path("/home/user/file.txt"),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn percent_encode_path_spaces() {
        assert_eq!(
            percent_encode_path("/home/user/My Documents"),
            "/home/user/My%20Documents"
        );
    }

    #[test]
    fn percent_encode_roundtrip() {
        let original = "/home/user/My Documents/file#name.txt";
        let encoded = percent_encode_path(original);
        let decoded = percent_decode(&encoded);
        assert_eq!(decoded, original);
    }

    #[test]
    fn paths_to_uris_basic() {
        let paths = vec![
            "/home/user/doc.txt".to_string(),
            "/tmp/test file.txt".to_string(),
        ];
        let uris = paths_to_uris(&paths);
        assert_eq!(
            uris,
            vec!["file:///home/user/doc.txt", "file:///tmp/test%20file.txt",]
        );
    }
}
