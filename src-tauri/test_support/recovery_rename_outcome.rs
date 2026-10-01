use super::*;
use crate::files::object_id::ObjectId;

fn version(inode: u64) -> EntryVersion {
    EntryVersion {
        object: ObjectId::unix(1, inode),
        size: 9,
        modified_seconds: 10,
        modified_nanos: 11,
        directory: false,
        symlink: false,
        mode: 0o100600,
        uid: 1000,
        gid: 1000,
    }
}

#[test]
fn both_endpoints_must_agree_before_a_rename_can_be_confirmed() {
    let expected = version(1);
    let different = version(2);
    let observations = [None, Some(&expected), Some(&different)];
    let outcomes = [
        [
            RenamePosition::Conflict,
            RenamePosition::Moved,
            RenamePosition::Conflict,
        ],
        [
            RenamePosition::Unmoved,
            RenamePosition::Conflict,
            RenamePosition::Conflict,
        ],
        [
            RenamePosition::Conflict,
            RenamePosition::Conflict,
            RenamePosition::Conflict,
        ],
    ];
    for (source_index, source) in observations.iter().enumerate() {
        for (target_index, target) in observations.iter().enumerate() {
            assert_eq!(
                classify(*source, *target, &expected),
                outcomes[source_index][target_index]
            );
        }
    }
}

#[test]
fn matching_inode_with_changed_contents_or_permissions_is_never_a_confirmed_move() {
    let expected = version(1);
    let mut changed = expected.clone();
    changed.modified_nanos += 1;
    assert_eq!(
        classify(None, Some(&changed), &expected),
        RenamePosition::Conflict
    );
    changed = expected.clone();
    changed.mode = 0o100400;
    assert_eq!(
        classify(Some(&changed), None, &expected),
        RenamePosition::Conflict
    );
}
