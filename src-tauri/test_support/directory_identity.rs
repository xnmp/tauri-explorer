use super::*;

#[test]
fn unix_lexical_identity_folds_repeated_and_trailing_separators() {
    #[cfg(not(windows))]
    {
        assert_eq!(resolve("/tmp//Folder/./"), "/tmp/Folder");
        assert_ne!(resolve("/tmp/Folder"), resolve("/tmp/folder"));
    }
}

#[test]
fn windows_drive_spelling_has_one_root_and_normalized_components() {
    let spelling = WindowsSpelling::parse(r"c:/Users//Mixed/./Folder/").unwrap();
    assert_eq!(spelling.root, r"C:\");
    assert_eq!(spelling.components, ["Users", "Mixed", "Folder"]);
    assert!(spelling.stored_case);
    assert_eq!(
        WindowsSpelling::join(&spelling.root, &spelling.components),
        r"C:\Users\Mixed\Folder"
    );
}

#[test]
fn windows_unc_and_wsl_roots_keep_the_requested_provider_spelling() {
    let unc = WindowsSpelling::parse(r"\\Server\Share\\Folder\").unwrap();
    assert_eq!(unc.root, r"\\Server\Share");
    assert_eq!(unc.components, ["Folder"]);
    assert!(unc.stored_case);

    let wsl = WindowsSpelling::parse(r"\\wsl.localhost\Ubuntu\Home\User").unwrap();
    assert_eq!(wsl.root, r"\\wsl.localhost\Ubuntu");
    assert_eq!(wsl.components, ["Home", "User"]);
    assert!(!wsl.stored_case);
}

#[test]
fn literal_windows_namespaces_are_not_rewritten() {
    for path in [r"\\?\C:\Mixed\.", r"\\.\PhysicalDrive0"] {
        assert_eq!(resolve(path), path);
        assert!(WindowsSpelling::parse(path).is_none());
    }
}

#[test]
fn incomplete_or_relative_windows_spellings_are_not_claimed() {
    for path in [r"C:relative", r"\rooted", r"relative\path", r"\\server"] {
        assert!(WindowsSpelling::parse(path).is_none(), "{path}");
    }
}
