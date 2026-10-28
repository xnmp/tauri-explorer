use super::ReleasePolicy;

fn releases(entries: &[usize]) -> Vec<bool> {
    let mut policy = ReleasePolicy::default();
    entries
        .iter()
        .map(|&count| policy.listing_encoded(count))
        .collect()
}

#[test]
fn small_listings_never_release() {
    assert_eq!(releases(&[0, 12, 9_999, 3]), [false; 4]);
}

#[test]
fn a_large_listing_releases_now_and_once_more_at_the_next_listing() {
    // The second release returns the large reply's memory, freed after delivery.
    assert_eq!(
        releases(&[5, 100_000, 4, 4, 4]),
        [false, true, true, false, false]
    );
}

#[test]
fn consecutive_large_listings_each_release_and_leave_one_owed() {
    assert_eq!(
        releases(&[10_000, 500_000, 2, 2]),
        [true, true, true, false]
    );
}
