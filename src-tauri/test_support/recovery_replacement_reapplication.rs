use super::*;
use crate::files::object_id::ObjectId;

fn version(inode: u64, mode: u32) -> EntryVersion {
    EntryVersion {
        object: ObjectId::unix(1, inode),
        size: 9,
        modified_seconds: 10,
        modified_nanos: 11,
        directory: mode & 0o170000 == 0o040000,
        symlink: false,
        mode,
        uid: 1000,
        gid: 1000,
    }
}

#[test]
fn every_endpoint_combination_has_a_conservative_next_step() {
    let original = version(1, 0o100600);
    let staged = StagedPayload {
        version: version(2, 0o040700),
        final_mode: Some(0o500),
    };
    let finalized = staged.published_version().unwrap();
    let different = version(3, 0o100600);
    let originals = [None, Some(&original), Some(&different)];
    let publications = [
        None,
        Some(&staged.version),
        Some(&finalized),
        Some(&different),
    ];
    let targets = [
        None,
        Some(&original),
        Some(&staged.version),
        Some(&finalized),
        Some(&different),
    ];
    // Only the restored pair, parked pair, and already-published pair are legal.
    let allowed = [
        ((0, 1, 1), ReapplicationStep::ParkOriginal),
        ((1, 1, 0), ReapplicationStep::PublishCopy),
        ((1, 0, 2), ReapplicationStep::Complete),
        ((1, 0, 3), ReapplicationStep::Complete),
    ];
    for (o, retained) in originals.into_iter().enumerate() {
        for (p, private) in publications.into_iter().enumerate() {
            for (t, target) in targets.into_iter().enumerate() {
                let expected = allowed
                    .iter()
                    .find(|(key, _)| *key == (o, p, t))
                    .map_or(ReapplicationStep::Conflict, |(_, step)| *step);
                assert_eq!(
                    reapplication_step(retained, private, target, &original, &staged).unwrap(),
                    expected,
                    "original {o}, private copy {p}, target {t}"
                );
            }
        }
    }
}

#[test]
fn changed_versions_and_aliases_do_not_grant_reapplication() {
    let original = version(1, 0o100600);
    let staged = StagedPayload {
        version: version(2, 0o100600),
        final_mode: None,
    };
    let mut changed = original.clone();
    changed.modified_nanos += 1;
    assert_eq!(
        reapplication_step(
            Some(&changed),
            Some(&staged.version),
            None,
            &original,
            &staged
        )
        .unwrap(),
        ReapplicationStep::Conflict
    );
    let mut changed = staged.version.clone();
    changed.size += 1;
    assert_eq!(
        reapplication_step(Some(&original), None, Some(&changed), &original, &staged).unwrap(),
        ReapplicationStep::Conflict
    );
    assert!(reapplication_step(None, None, None, &staged.version, &staged).is_err());
    let malformed = StagedPayload {
        version: staged.version,
        final_mode: Some(0o700),
    };
    assert!(reapplication_step(None, None, None, &original, &malformed).is_err());
}
