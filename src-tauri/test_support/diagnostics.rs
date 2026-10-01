use super::*;

#[test]
fn newline_joined_diagnostics_including_omission_fit_the_output_budget() {
    let warnings: Warnings = ["x".repeat(32 * 1024)].into_iter().collect();
    let rendered = warnings.into_vec().join("\n");
    assert!(rendered.len() <= 16 * 1024);
    assert!(rendered.ends_with("Additional warnings were omitted"));
}

#[test]
fn diagnostics_keep_first_occurrence_order_and_remove_duplicates() {
    let warnings: Warnings = ["second", "first", "second", ""]
        .into_iter()
        .map(String::from)
        .collect();
    assert_eq!(warnings.into_vec(), vec!["second", "first"]);
}

#[test]
fn large_batches_report_omission_without_collecting_every_message() {
    let seen = std::cell::Cell::new(0);
    let warnings: Warnings = (0..100_000)
        .map(|i| {
            seen.set(seen.get() + 1);
            format!("warning {i}")
        })
        .collect();
    let warnings = warnings.into_vec();
    assert!(seen.get() <= 32);
    assert!(warnings.len() <= 32);
    assert_eq!(warnings.last().unwrap(), "Additional warnings were omitted");
    assert_eq!(warnings.first().unwrap(), "warning 0");
}

#[test]
fn oversized_unicode_message_is_bounded_without_splitting_a_character() {
    let mut warnings = Warnings::default();
    warnings.push("retained diagnostic");
    warnings.push("🦀".repeat(100_000));
    warnings.push("later diagnostic");
    let warnings = warnings.into_vec();
    assert!(warnings.iter().map(String::len).sum::<usize>() <= 16 * 1024);
    assert!(warnings.iter().map(String::capacity).sum::<usize>() <= 16 * 1024);
    assert_eq!(warnings[0], "retained diagnostic");
    assert!(warnings[1].chars().all(|c| c == '🦀'));
    assert_eq!(warnings.last().unwrap(), "Additional warnings were omitted");
}
