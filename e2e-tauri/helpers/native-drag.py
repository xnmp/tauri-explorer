"""Exercise GTK source ownership using XTest, exclusively on a private Xvfb."""
import argparse
import ctypes
import os
from pathlib import Path
import subprocess
import time

ISOLATION_KEYS = (
    "DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME",
    "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
)


def processes():
    for directory in Path("/proc").glob("[0-9]*"):
        try:
            arguments = directory.joinpath("cmdline").read_bytes().decode().split("\0")
            environment = dict(item.split("=", 1) for item in
                               directory.joinpath("environ").read_bytes().decode().split("\0") if "=" in item)
            yield int(directory.name), arguments, environment
        except (OSError, UnicodeError):
            continue


def property_value(window, name):
    return subprocess.check_output(["xprop", "-id", hex(window), name], text=True).split()[-1]


def admit_private_application():
    display = os.environ.get("DISPLAY", "")
    assert display.startswith(":"), "Native input requires a local private display"
    assert os.environ.get("GDK_BACKEND") == "x11" and not os.environ.get("WAYLAND_DISPLAY")
    assert os.environ.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:path=/tmp/"), "Private D-Bus required"
    profile = Path(os.environ["XDG_RUNTIME_DIR"]).resolve().parent
    metadata = profile.stat()
    assert profile not in (Path("/"), Path.home()), "Dedicated profile required"
    assert metadata.st_uid == os.getuid() and metadata.st_mode & 0o777 == 0o700, "Private profile must be owned mode700"
    for key in ISOLATION_KEYS[2:]:
        directory = Path(os.environ[key]).resolve()
        assert directory.is_dir() and directory.is_relative_to(profile), f"{key} escapes private profile"
    rows = list(processes())
    assert any(Path(args[0]).name == "Xvfb" and display.split(".")[0] in args for _, args, _ in rows), "Refusing input outside verified Xvfb"
    active = subprocess.check_output(["xprop", "-root", "_NET_ACTIVE_WINDOW"], text=True)
    window = int(active.split()[-1], 16)
    application_pid = int(property_value(window, "_NET_WM_PID"))
    application = next(environment for pid, _, environment in rows if pid == application_pid)
    assert application.get("TAURI_WEBVIEW_AUTOMATION") == "true", "Active window is not an automation app"
    assert "tauri-explorer" in Path(f"/proc/{application_pid}/exe").resolve().name, "Active window is not TraceExplorer"
    drivers = [environment for _, args, environment in rows if Path(args[0]).name == "tauri-driver"
               and environment.get("DISPLAY") == display]
    assert len(drivers) == 1, "Expected one private native driver"
    # App, driver, WebKit children and D-Bus activated portal helpers must all
    # inherit isolation before input. Never inspect or alter another bus's apps.
    scoped = [environment for _, args, environment in rows
              if environment.get("DBUS_SESSION_BUS_ADDRESS") == os.environ["DBUS_SESSION_BUS_ADDRESS"]
              and ("WebKit" in args[0] or "xdg-desktop-portal" in args[0])]
    for environment in [application, *drivers, *scoped]:
        for key in ISOLATION_KEYS:
            assert environment.get(key) == os.environ.get(key), f"Private process differs in {key}"
    return window


def drag(window, start_x, start_y, end_x, end_y, copy=False):
    x11 = ctypes.CDLL("libX11.so.6")
    xtest = ctypes.CDLL("libXtst.so.6")
    pointer = ctypes.c_void_p
    x11.XOpenDisplay.restype = pointer
    x11.XDefaultRootWindow.argtypes = [pointer]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XTranslateCoordinates.argtypes = [pointer, ctypes.c_ulong, ctypes.c_ulong,
        ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong)]
    x11.XFlush.argtypes = [pointer]
    x11.XCloseDisplay.argtypes = [pointer]
    x11.XSync.argtypes = [pointer, ctypes.c_int]
    x11.XKeysymToKeycode.argtypes = [pointer, ctypes.c_ulong]
    x11.XKeysymToKeycode.restype = ctypes.c_uint
    xtest.XTestFakeMotionEvent.argtypes = [pointer, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtest.XTestFakeButtonEvent.argtypes = [pointer, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtest.XTestFakeKeyEvent.argtypes = [pointer, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x11.XOpenDisplay(None)
    assert display, "Could not connect to verified Xvfb display"
    pressed = False
    control_pressed = False
    control_key = x11.XKeysymToKeycode(display, 0xffe3)
    try:
        origin_x, origin_y, child = ctypes.c_int(), ctypes.c_int(), ctypes.c_ulong()
        root = x11.XDefaultRootWindow(display)
        assert x11.XTranslateCoordinates(display, window, root, 0, 0,
            ctypes.byref(origin_x), ctypes.byref(origin_y), ctypes.byref(child))

        def move(x, y):
            xtest.XTestFakeMotionEvent(display, -1, origin_x.value + x, origin_y.value + y, 0)
            x11.XFlush(display)

        move(start_x, start_y)
        time.sleep(0.2)
        xtest.XTestFakeButtonEvent(display, 1, True, 0)
        x11.XFlush(display)
        pressed = True
        time.sleep(0.2)
        if copy:
            assert control_key, "Control key is unavailable on the private display"
            xtest.XTestFakeKeyEvent(display, control_key, True, 0)
            x11.XFlush(display)
            control_pressed = True
        # Keep moving while the asynchronous native handoff runs. One final
        # motion before IPC resolves would never exercise the admitted source.
        for step in range(1, 21):
            move(start_x + round((end_x - start_x) * step / 20),
                 start_y + round((end_y - start_y) * step / 20))
            time.sleep(0.05)
        time.sleep(0.5)
    finally:
        if pressed:
            xtest.XTestFakeButtonEvent(display, 1, False, 0)
            x11.XSync(display, False)
            # Keep the XTest client alive until GTK consumes release; closing
            # its connection during delivery can cancel the synthetic device.
            time.sleep(0.5)
        if control_pressed:
            xtest.XTestFakeKeyEvent(display, control_key, False, 0)
            x11.XSync(display, False)
        x11.XCloseDisplay(display)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for coordinate in ("start_x", "start_y", "end_x", "end_y"):
        parser.add_argument(coordinate, type=int)
    parser.add_argument("--copy", action="store_true")
    arguments = parser.parse_args()
    drag(admit_private_application(), arguments.start_x, arguments.start_y,
         arguments.end_x, arguments.end_y, arguments.copy)
