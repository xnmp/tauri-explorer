use super::{
    validate_selection, WindowsPathKey, MAX_COMPONENTS_PER_PATH, MAX_SELECTION_COMPONENTS,
};
use std::{cmp::Ordering, path::Path};

fn paths(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn compare(left: &str, right: &str) -> Result<Ordering, crate::error::AppError> {
    WindowsPathKey::new(Path::new(left)).compare(&WindowsPathKey::new(Path::new(right)))
}

#[test]
fn ordinal_identity_folds_only_supported_dos_and_unc_aliases() {
    assert_eq!(
        compare(r"C:\Work\Ä.txt", r"\\?\c:\work\ä.TXT").unwrap(),
        Ordering::Equal
    );
    assert_eq!(
        compare(
            r"\\Server\Share\Folder\Item.txt",
            r"\\?\UNC\server\share\folder\ITEM.TXT",
        )
        .unwrap(),
        Ordering::Equal
    );
    assert!(compare(r"\\?\UNC\server\share\item", r"UNC\server\share\item").is_err());
    assert!(compare(r"\\?\Volume{1234}\item", r"Volume{1234}\item").is_err());
}

#[test]
fn source_keys_fail_closed_before_folding_ambiguous_supported_paths() {
    for (ordinary, verbatim) in [
        (r"C:\root\NUL", r"\\?\C:\root\NUL"),
        (r"C:\root\file::$DATA", r"\\?\C:\root\file::$DATA"),
        (r"C:\root\name. ", r"\\?\C:\root\name. "),
    ] {
        assert!(compare(ordinary, verbatim).is_err());
    }
}

#[test]
fn semantic_duplicate_dos_and_unc_spellings_are_rejected() {
    for selection in [
        paths(&[r"C:\Work\Item.txt", r"\\?\c:\work\ITEM.TXT"]),
        paths(&[
            r"\\Server\Share\Folder\Item.txt",
            r"\\?\UNC\server\share\folder\ITEM.TXT",
        ]),
    ] {
        assert!(validate_selection(&selection)
            .unwrap_err()
            .contains("multiple Windows spellings"));
    }
}

#[test]
fn component_ordering_finds_ancestor_with_an_intervening_sibling_name() {
    let selection = paths(&[
        r"C:\root\dir",
        r"C:\root\dir-file",
        r"c:\ROOT\dir\child.txt",
    ]);
    assert!(validate_selection(&selection)
        .unwrap_err()
        .contains("directory or its descendants"));
}

#[test]
fn reserved_dos_names_and_extension_variants_are_rejected() {
    for name in [
        "NUL",
        "nul.txt",
        "NUL .txt",
        "CONIN$.log",
        "CONOUT$",
        "COM1.bin",
        "COM1 .log",
        "LPT9",
        "LPT³.txt",
    ] {
        let path = format!(r"C:\root\{name}");
        assert!(
            validate_selection(&[path])
                .unwrap_err()
                .contains("reserved"),
            "reserved name was admitted: {name}"
        );
    }
    validate_selection(&paths(&[
        r"C:\root\COM10.txt",
        r"D:\root\NULL",
        r"E:\root\.git",
        r"F:\root\.env",
    ]))
    .unwrap();
}

#[test]
fn streams_wildcards_controls_and_win32_ambiguous_components_are_rejected() {
    for name in [
        "file::$DATA",
        "*.txt",
        "question?.txt",
        "quote\".txt",
        "less<.txt",
        "greater>.txt",
        "pipe|.txt",
    ] {
        let path = format!(r"C:\root\{name}");
        assert!(
            validate_selection(&[path]).is_err(),
            "invalid selected-item character was admitted: {name}"
        );
    }
    for path in [
        "C:\\root\\line\nfeed.txt",
        r"C:\root\\item.txt",
        r"C:\root\.\item.txt",
        r"C:\root\item.txt.",
        r"C:\root\item.txt ",
        r"\\?\C:/root/item.txt",
    ] {
        assert!(
            validate_selection(&paths(&[path])).is_err(),
            "ambiguous path was admitted: {path}"
        );
    }
}

#[test]
fn unc_server_share_and_selected_item_rules_are_separate() {
    validate_selection(&paths(&[r"\\server\admin$\NUL-safe.txt"])).unwrap();
    for path in [
        r"\\bad[server]\share\item.txt",
        r"\\server\bad+share\item.txt",
        r"\\server\share\NUL.txt",
    ] {
        assert!(validate_selection(&paths(&[path])).is_err());
    }
}

#[test]
fn unsupported_namespaces_are_not_admitted_or_aliased() {
    for path in [
        r"\\?\Volume{1234}\item.txt",
        r"\\.\PhysicalDrive0\item.txt",
        r"relative\item.txt",
    ] {
        assert!(validate_selection(&paths(&[path])).is_err());
    }
}

#[test]
fn component_limits_bound_compare_work_without_limiting_component_bytes() {
    let large_component = "x".repeat(1024);
    validate_selection(&[format!(r"C:\{large_component}")]).unwrap();

    let accepted = format!(
        r"C:\{}",
        (0..MAX_COMPONENTS_PER_PATH - 1)
            .map(|index| format!("p{index}"))
            .collect::<Vec<_>>()
            .join(r"\")
    );
    validate_selection(&[accepted]).unwrap();

    let too_deep = format!(
        r"C:\{}",
        (0..MAX_COMPONENTS_PER_PATH)
            .map(|index| format!("p{index}"))
            .collect::<Vec<_>>()
            .join(r"\")
    );
    assert!(validate_selection(&[too_deep])
        .unwrap_err()
        .contains("component limit"));
}

#[test]
fn aggregate_component_limit_precedes_sorting_work() {
    let shared = (0..MAX_COMPONENTS_PER_PATH - 2)
        .map(|index| format!("p{index}"))
        .collect::<Vec<_>>()
        .join(r"\");
    let path_count = MAX_SELECTION_COMPONENTS / MAX_COMPONENTS_PER_PATH + 1;
    let selection: Vec<_> = (0..path_count)
        .map(|index| format!(r"C:\{shared}\leaf-{index}"))
        .collect();

    assert!(validate_selection(&selection)
        .unwrap_err()
        .contains("component limit"));
}

#[test]
fn validation_does_not_rewrite_receipt_spellings() {
    let selection = paths(&[r"C:/Mixed/Original.TXT", r"D:\Other\Item.txt"]);
    let retained = selection.clone();
    validate_selection(&selection).unwrap();
    assert_eq!(selection, retained);
}
