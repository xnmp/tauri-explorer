use std::path::Path;

const MAX_AVATAR_BYTES: usize = 256 * 1024;

fn resolve_avatar_url(_email: &str, _gravatar_enabled: bool) -> Option<String> {
    None
}

fn load_or_fetch<F>(
    _cache_dir: &Path,
    _email: &str,
    _gravatar_enabled: bool,
    _fetch: F,
) -> Option<Vec<u8>>
where
    F: FnOnce(&str) -> Result<Vec<u8>, ()>,
{
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn github_noreply_addresses_use_bounded_github_urls() {
        assert_eq!(
            resolve_avatar_url("12345+octocat@users.noreply.github.com", false).as_deref(),
            Some("https://avatars.githubusercontent.com/u/12345?s=64")
        );
        assert_eq!(
            resolve_avatar_url("octocat@users.noreply.github.com", false).as_deref(),
            Some("https://avatars.githubusercontent.com/octocat?s=64")
        );
    }

    #[test]
    fn ordinary_email_never_routes_to_gravatar_without_consent() {
        assert_eq!(resolve_avatar_url("person@example.com", false), None);
        assert!(resolve_avatar_url("person@example.com", true)
            .is_some_and(|url| url.starts_with("https://www.gravatar.com/avatar/") && url.ends_with("?s=64&d=404")));
    }

    #[test]
    fn valid_download_is_reused_from_disk_without_a_second_request() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Cell::new(0);
        let png = include_bytes!("../icons/32x32.png").to_vec();
        let first = load_or_fetch(temp.path(), "octocat@users.noreply.github.com", false, |_| {
            calls.set(calls.get() + 1);
            Ok(png.clone())
        });
        let second = load_or_fetch(temp.path(), "octocat@users.noreply.github.com", false, |_| {
            calls.set(calls.get() + 1);
            Err(())
        });
        assert_eq!(first, Some(png.clone()));
        assert_eq!(second, Some(png));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn corrupt_and_oversized_downloads_degrade_to_no_image() {
        let corrupt = tempfile::tempdir().unwrap();
        assert_eq!(load_or_fetch(corrupt.path(), "octocat@users.noreply.github.com", false, |_| Ok(b"not an image".to_vec())), None);
        let oversized = tempfile::tempdir().unwrap();
        assert_eq!(load_or_fetch(oversized.path(), "octocat@users.noreply.github.com", false, |_| Ok(vec![0; MAX_AVATAR_BYTES + 1])), None);
    }

    #[test]
    fn a_failed_download_is_negative_cached() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Cell::new(0);
        for _ in 0..2 {
            assert_eq!(load_or_fetch(temp.path(), "octocat@users.noreply.github.com", false, |_| {
                calls.set(calls.get() + 1);
                Err(())
            }), None);
        }
        assert_eq!(calls.get(), 1);
    }
}
