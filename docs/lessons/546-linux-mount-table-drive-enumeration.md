# Linux mount-table drive enumeration (#546)

Linux removable media cannot be discovered reliably by scanning conventional
mount directories: desktop launch environments may omit `USER`, and valid
mounts may live anywhere. Read `/proc/self/mountinfo`, decode its escaped mount
paths, and resolve each `/dev` partition back to its parent `/sys/block` device
to read the kernel's `removable` flag. Keep pseudo filesystems out of the drive
list, exclude operating-system roots and submounts such as `/boot/efi` and
`/home`, and use `/dev/disk/by-label` when udev provides a volume label. Keep
the complete production enumeration path injectable so mount/unmount behavior
is testable without host mounts or environment variables.
