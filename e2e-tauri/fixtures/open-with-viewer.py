"""A disposable installed GTK application for real desktop-entry dispatch."""
import hashlib
import json
import os
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

source = sys.argv[1]
with open(source, "rb") as handle:
    content = handle.read()
window = Gtk.Window(title="Acceptance Alternate Viewer")
window.set_default_size(680, 360)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(20)
box.pack_start(Gtk.Label(label="Acceptance Alternate Viewer", xalign=0), False, False, 0)
filename = Gtk.Label(label=os.path.basename(source), xalign=0)
filename.set_line_wrap(True)
box.pack_start(filename, False, False, 0)
text = Gtk.TextView(editable=False, cursor_visible=False)
text.get_buffer().set_text(content.decode("utf8"))
box.pack_start(text, True, True, 0)
window.add(box)
window.connect("destroy", Gtk.main_quit)
window.show_all()
with open(os.environ["TAURI_NATIVE_OPEN_WITH_RECEIPT"], "w") as handle:
    json.dump({"path": source, "sha256": hashlib.sha256(content).hexdigest(), "pid": os.getpid(),
               "environment": {key: os.environ.get(key) for key in ("DISPLAY", "GDK_BACKEND", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "WAYLAND_DISPLAY")}}, handle)
Gtk.main()
