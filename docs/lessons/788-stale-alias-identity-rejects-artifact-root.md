# 788 — A recorded identity is only evidence while its object is alive

A durable overwrite copy through a symlinked parent failed after the link was
retargeted, with "Recovery manifest does not belong to this artifact root".
In CI it showed up as the flake
`alias_retargeting_after_preparation_never_replans_a_later_destination`.

## Cause

Admission records each symlink an admitted path traverses as a `Read`/`Entry`
parent-alias resource, together with the link's inode. That entry fences
admission only: the operation neither keeps the link alive nor forbids
retargeting it. Retargeting frees the old inode. On ext4 and XFS the next
directory created can receive that inode number, and the new artifact root is
such a directory. `manifest_payload` compared the root's identity with every
intent resource, so it read the reused number as "this root aliases a user
object" and refused a root it had just created. `MoveSpec::validate_root` made
the same comparison.

A new identity may only be compared with identities the operation keeps
alive: its subjects (subtree claims whose versions it verifies) and its
parents. `move_capability_model.rs` already applied this rule to removed
rename probes.

## Why it never reproduced locally

`/tmp` here is tmpfs, whose inode numbers only increase and are never reused.
On a quiet ext4 volume the replacement symlink usually takes the freed inode
straight back. On CI, other test threads deleting files in the same block group
opened lower free inodes: the new link and the catalog intent file took those,
and the root got the old link's number. To reproduce, put `TMPDIR` on ext4 and
free a few inodes around the link's creation. Better, test the rule directly:
push an alias entry recording the root's identity, as
`a_reused_parent_alias_identity_does_not_disown_a_fresh_root` does.

## When hunting similar flakes

An identity comparison that fails only on CI, with "aliases"/"does not belong"
wording, is a reuse candidate. Ask what keeps the compared object alive between
capture and comparison. If nothing does, the comparison is not evidence.
