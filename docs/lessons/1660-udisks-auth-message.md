# #1660 — "can't mount external hdd": UDisks `NotAuthorizedCanObtain`

The report showed `org.freedesktop.UDisks2.Error.NotAuthorizedCanObtain`.
Explorer already lets UDisks authenticate interactively (it passes an empty
options dict, ADR 0025), so this name means polkit *would* allow the mount
after authentication but no authentication agent answered. Two common causes:

- no polkit agent is running (usual on tiling window managers that do not
  autostart one), or
- the disk is a UDisks system disk (`HintSystem=true`, some USB-SATA bridges),
  so `filesystem-mount-system` asks for administrator authentication that,
  again, needs an agent. `udisksctl info -b /dev/sdX1 | grep HintSystem` tells.

Neither is an Explorer defect, but the raw D-Bus text ("Not authorized to
perform operation") gave the user no cause or remedy.
`files/linux_volumes.rs::mount_failure_message` maps the named UDisks polkit
errors (`NotAuthorizedCanObtain`, `NotAuthorizedDismissed`, `NotAuthorized`)
to messages that name the cause and remedy, including `udisksctl mount -b
<device>` with the volume's own device. Every other error keeps the raw text.

- Match the D-Bus error *name* (`zbus::Error::MethodError`), never its
  message: udisksd's text is localized and changes between versions.
- The isolated-bus fixture (`test_support/linux_removable_volumes.rs`) returns
  real named errors through a `zbus::DBusError` enum, so the regression runs
  the production adapter rather than a transcribed mapping.
