use super::*;

#[test]
fn a_replaced_source_is_not_permanently_removed() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    let retained = root.path().join("original");
    fs::write(&source, b"selected bytes").unwrap();
    let deletion = Prepared::capture(&source).unwrap();
    fs::rename(&source, &retained).unwrap();
    fs::write(&source, b"unrelated replacement").unwrap();
    let result = deletion.execute();
    assert_eq!(
        fs::read(&source).ok().as_deref(),
        Some(b"unrelated replacement".as_slice())
    );
    assert_eq!(fs::read(&retained).unwrap(), b"selected bytes");
    assert!(result.is_err());
}

#[test]
fn a_replaced_parent_does_not_redirect_deletion() {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("parent");
    let retained = root.path().join("original-parent");
    fs::create_dir(&parent).unwrap();
    let source = parent.join("selected");
    fs::write(&source, b"selected bytes").unwrap();
    let deletion = Prepared::capture(&source).unwrap();
    fs::rename(&parent, &retained).unwrap();
    fs::create_dir(&parent).unwrap();
    fs::write(&source, b"unrelated replacement").unwrap();
    let result = deletion.execute();
    assert_eq!(
        fs::read(&source).ok().as_deref(),
        Some(b"unrelated replacement".as_slice())
    );
    assert_eq!(
        fs::read(retained.join("selected")).unwrap(),
        b"selected bytes"
    );
    assert!(result.is_err());
}
