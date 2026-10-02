"""Inspect private Thunar accessibility and select its actual List View."""
import json
import os
import sys
import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib

if "--trash-count" in sys.argv:
    expected = Gio.File.new_for_path(os.path.join(GLib.get_user_data_dir(), "Trash", "files"))
    enumerator = Gio.File.new_for_uri("trash:///").enumerate_children(
        "standard::target-uri", Gio.FileQueryInfoFlags.NONE, None)
    count = 0
    while True:
        entry = enumerator.next_file(None)
        if entry is None:
            break
        uri = entry.get_attribute_string("standard::target-uri")
        if not uri or not expected.equal(Gio.File.new_for_uri(uri).get_parent()):
            raise RuntimeError("Trash includes a source outside the private task profile")
        count += 1
    enumerator.close(None)
    print(json.dumps(count))
    raise SystemExit(0)

desktop = Atspi.get_desktop(0)
names = []
for index in range(desktop.get_child_count()):
    application = desktop.get_child_at_index(index)
    if "thunar" not in (application.get_name() or "").lower():
        continue
    pending = [(application, 0)]
    observed = 0
    while pending and observed < 2000:
        node, depth = pending.pop()
        observed += 1
        try:
            name = node.get_name()
            if name:
                names.append(name)
            if name == "List View" and "--list-view" in sys.argv:
                action = node.get_action_iface()
                if action:
                    action.do_action(0)
            if depth < 20:
                pending.extend((node.get_child_at_index(i), depth + 1)
                               for i in range(min(node.get_child_count(), 200)))
        except Exception:
            continue
print(json.dumps(names))
