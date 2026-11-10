# Moving a symlink into its own target is not "into itself" (#1594)

`reject_dir_into_itself` canonicalised the source, so a link `L -> A` moved or
copied into `A/sub` resolved to `A` and was rejected. Copy recreates symlinks
(never follows them) and move renames the link, so neither recurses into the
target; the guard now classifies the source with `symlink_metadata` and ignores
symlinks. A real directory moved or copied into itself through a symlinked
destination spelling is still rejected (destination is still canonicalised).
All callers (copy, move, move session) share the one guard, so the decision is
consistent. `issue_1594_symlink_into_its_own_target_through_copy_and_move` pins
this through the real copy/move entry points (link recreated with no recursion,
link renamed with target intact, alias spelling refused with the tree unchanged).
If copy ever starts following directory symlinks, this exemption must go.
