//! WSL path recognition shared by every feature that delegates work into a
//! distro's native tooling instead of crossing the 9P boundary per file:
//! terminals (#378), Quick Open search (#414), SCM git (#398).

/// Parse a WSL UNC path (`\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…`,
/// either separator style) into `(distro, linux_path)`. Platform-independent
/// so the parsing rules are unit-testable everywhere.
pub fn parse_wsl_unc(path: &str) -> Option<(String, String)> {
    let norm = path.replace('/', "\\");
    let rest = norm
        .strip_prefix("\\\\wsl$\\")
        .or_else(|| norm.strip_prefix("\\\\wsl.localhost\\"))?;
    let (distro, tail) = match rest.split_once('\\') {
        Some((d, t)) => (d, t),
        None => (rest, ""),
    };
    if distro.is_empty() {
        return None;
    }
    Some((distro.to_string(), format!("/{}", tail.replace('\\', "/"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_unc_paths_parse_to_distro_and_linux_path() {
        assert_eq!(
            parse_wsl_unc(r"\\wsl.localhost\Ubuntu\home\me\proj"),
            Some(("Ubuntu".into(), "/home/me/proj".into()))
        );
        assert_eq!(
            parse_wsl_unc(r"\\wsl$\Debian\tmp"),
            Some(("Debian".into(), "/tmp".into()))
        );
        // Forward-slash style tolerated.
        assert_eq!(
            parse_wsl_unc("//wsl.localhost/Ubuntu/home/me"),
            Some(("Ubuntu".into(), "/home/me".into()))
        );
        // Distro root maps to /.
        assert_eq!(
            parse_wsl_unc(r"\\wsl$\Ubuntu"),
            Some(("Ubuntu".into(), "/".into()))
        );
        // Non-WSL paths pass through as None.
        assert_eq!(parse_wsl_unc(r"C:\Users\me"), None);
        assert_eq!(parse_wsl_unc("/home/me"), None);
        assert_eq!(parse_wsl_unc(r"\\server\share"), None);
    }
}
