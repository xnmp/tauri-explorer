# 794: parent-alias claims must not own object identity

Recovery records capture every traversed parent symlink as a Read/Entry resource.
Recording the symlink's inode made an unresolved record refuse any later write
whose subject reused that inode ("Another operation or unresolved recovery owns
these files"). Aliases are now captured with `object: None` (path fence only);
schema and on-disk records are unchanged (old records keep their stale object).
Trade-off: a hardlink to the symlink itself is no longer fenced by identity.
