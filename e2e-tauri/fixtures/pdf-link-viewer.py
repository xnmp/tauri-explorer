"""Disposable URI handler: displays the received URL without fetching it."""
import json
import os
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

window = Gtk.Window(title="Acceptance PDF Link Viewer")
window.set_default_size(700, 180)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
box.set_border_width(24)
box.pack_start(Gtk.Label(label="PDF external link received", xalign=0), False, False, 0)
box.pack_start(Gtk.Label(label=sys.argv[1], xalign=0), False, False, 0)
window.add(box)
window.connect("destroy", Gtk.main_quit)
window.show_all()
with open(os.environ["TAURI_NATIVE_PDF_LINK_RECEIPT"], "w") as handle:
    json.dump({"url": sys.argv[1], "pid": os.getpid(), "environment": {
        key: os.environ.get(key) for key in ("DISPLAY", "GDK_BACKEND", "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS")
    }}, handle)
Gtk.main()
