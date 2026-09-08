//! Recycle Bin inventory lookup uses the same Windows spelling semantics as
//! restore completion, while returning receipts in the caller's spelling.
use super::{index_restore_items, take_restore_item};
use crate::{
    error::AppError,
    files::windows_restore::{restore_item, StaApartment},
};
use std::{fs, path::Path, thread};

#[test]
fn alternate_case_and_verbatim_requests_find_the_actual_trashed_item() {
    thread::spawn(|| {
        let apartment = StaApartment::new().unwrap();
        let directory = tempfile::tempdir().unwrap();
        for verbatim in [false, true] {
            let original = directory
                .path()
                .join(format!("OriginalCase-{verbatim}.TXT"));
            let contents = format!("exact inventory bytes {verbatim}");
            fs::write(&original, contents.as_bytes()).unwrap();
            trash::delete(&original).unwrap();
            let spelling = original
                .to_string_lossy()
                .replace('/', "\\")
                .to_ascii_lowercase();
            let plain = spelling.strip_prefix("\\\\?\\").unwrap_or(&spelling);
            let requested = if verbatim {
                format!("\\\\?\\{plain}")
            } else {
                plain.to_owned()
            };
            let mut indexed = index_restore_items(std::slice::from_ref(&requested)).unwrap();
            assert_eq!(indexed.len(), 1);
            assert!(indexed.contains_key(Path::new(&requested)));
            let item = take_restore_item(&mut indexed, &requested).unwrap();
            restore_item(&apartment, item).unwrap();
            assert_eq!(fs::read(&original).unwrap(), contents.as_bytes());
        }
    })
    .join()
    .unwrap();
}

#[test]
fn semantic_duplicate_requests_are_rejected_before_inventory_execution() {
    thread::spawn(|| {
        let _apartment = StaApartment::new().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("SameItem.TXT");
        fs::write(&original, b"untouched bytes").unwrap();
        let first = original.to_string_lossy().into_owned();
        let second = first.to_ascii_lowercase();
        assert_ne!(first, second);
        let error = index_restore_items(&[first, second]).unwrap_err();
        assert!(matches!(error, AppError::InvalidPath(_)));
        assert_eq!(fs::read(&original).unwrap(), b"untouched bytes");
    })
    .join()
    .unwrap();
}

#[test]
fn ordinal_keys_fold_unicode_case_without_aliasing_device_namespaces() {
    use crate::files::windows_restore::WindowsPathKey;
    use std::cmp::Ordering;
    let compare = |left: &str, right: &str| {
        WindowsPathKey::new(Path::new(left))
            .compare(&WindowsPathKey::new(Path::new(right)))
            .unwrap()
    };
    assert_eq!(
        compare(r"C:\Work\Ä.txt", r"\\?\c:\work\ä.TXT"),
        Ordering::Equal
    );
    assert_ne!(
        compare(r"\\?\UNC\server\share\item", r"UNC\server\share\item"),
        Ordering::Equal
    );
    assert_ne!(
        compare(r"\\?\Volume{1234}\item", r"Volume{1234}\item"),
        Ordering::Equal
    );
}
