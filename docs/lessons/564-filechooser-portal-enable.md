# FileChooser portal enablement

`xdg-desktop-portal` does not select a FileChooser backend merely because its
portal descriptor is installed. Users must set the preferred backend in
`~/.config/xdg-desktop-portal/portals.conf`; do not rely on the deprecated
`UseIn` mechanism for selection.
