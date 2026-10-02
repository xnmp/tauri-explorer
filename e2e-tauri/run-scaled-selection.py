"""Run #756 native acceptance on a private software Wayland compositor.

Requires sway/swaymsg, grim, Python GTK3, tauri-driver and a hooks-enabled
native debug binary. No host display, compositor or clipboard is used.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

root = Path(__file__).resolve().parent.parent
artifacts = root / "e2e-tauri/logs/scaled-selection"
artifacts.mkdir(parents=True, exist_ok=True)
private_session = "--private-session" in sys.argv
profile = Path(os.environ["TAURI_NATIVE_SELECTION_PROFILE"]) if private_session else Path(tempfile.mkdtemp(prefix="profile-", dir=artifacts))
runtime = Path(os.environ["XDG_RUNTIME_DIR"]) if private_session else Path(tempfile.mkdtemp(prefix="scaled-selection-", dir="/tmp"))
sway = os.environ.get("TAURI_NATIVE_SWAY", "sway")
swaymsg = os.environ.get("TAURI_NATIVE_SWAYMSG", "swaymsg")
for suffix in ["config", "data", "cache", "state"]:
    (profile / suffix).mkdir(exist_ok=True)
config = profile / "config/sway.conf"
config.write_text("""xwayland disable
output HEADLESS-1 mode 1600x1000 position 0 0 scale 1
output HEADLESS-2 mode 2000x1250 position 1600 0 scale 1.25
seat seat0 fallback true
focus_follows_mouse no
font pango:Sans 10
""")
environment = dict(os.environ)
for key in ["DISPLAY", "WAYLAND_DISPLAY", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_SOCKET", "AT_SPI_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "DBUS_SESSION_BUS_PID", "IBUS_ADDRESS"]:
    environment.pop(key, None)
environment.update({
    "TAURI_NATIVE_SELECTION_PROFILE": str(profile),
    "TAURI_NATIVE_SELECTION_ARTIFACT_DIR": str(artifacts),
    "TAURI_NATIVE_SWAYMSG": swaymsg,
    "TAURI_NATIVE_DRIVER_PORT": environment.get("TAURI_NATIVE_DRIVER_PORT", "4520"),
    "TAURI_NATIVE_BACKEND_PORT": environment.get("TAURI_NATIVE_BACKEND_PORT", "4521"),
    "XDG_RUNTIME_DIR": str(runtime), "GDK_BACKEND": "wayland",
    "WLR_BACKENDS": "headless", "WLR_RENDERER": "pixman", "WLR_HEADLESS_OUTPUTS": "2",
    **{f"XDG_{suffix.upper()}_HOME": str(profile / suffix) for suffix in ["config", "data", "cache", "state"]},
})

if not private_session:
    # Exec, rather than spawn: interruption reaches the isolated session too.
    os.execvpe("dbus-run-session", ["dbus-run-session", "--", "python3", str(Path(__file__).resolve()), "--private-session"], environment)

# Clear inherited connection aliases in the actual child environment too.
for key in ["WAYLAND_SOCKET", "AT_SPI_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "DBUS_SESSION_BUS_PID", "IBUS_ADDRESS"]:
    os.environ.pop(key, None)

# The child uses the parent's already-created private directories.
profile = Path(os.environ["TAURI_NATIVE_SELECTION_PROFILE"])
runtime = Path(os.environ["XDG_RUNTIME_DIR"])
config = profile / "config/sway.conf"
with (artifacts / "sway.log").open("w") as log:
    compositor = subprocess.Popen([sway, "-c", str(config)], stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if compositor.poll() is not None:
                raise RuntimeError("Private compositor exited; inspect sway.log")
            sockets = list(runtime.glob("sway-ipc.*.sock"))
            if sockets:
                result = subprocess.run([swaymsg, "-s", str(sockets[0]), "-t", "get_outputs", "-r"], capture_output=True, text=True)
                if result.returncode == 0:
                    outputs = json.loads(result.stdout)
                    if len(outputs) == 2:
                        break
            time.sleep(.1)
        else:
            raise RuntimeError("Private compositor readiness timed out")
        proc_env = dict(value.split("=", 1) for value in Path(f"/proc/{compositor.pid}/environ").read_text().split("\0") if "=" in value)
        if proc_env.get("WLR_BACKENDS") != "headless" or proc_env.get("WLR_RENDERER") != "pixman" or proc_env.get("DISPLAY") or proc_env.get("WAYLAND_DISPLAY"):
            raise RuntimeError("Compositor did not retain private software isolation")
        displays = [value for value in runtime.glob("wayland-*") if value.is_socket()]
        if len(displays) != 1:
            raise RuntimeError("Private Wayland socket identity is ambiguous")
        native_env = dict(os.environ, SWAYSOCK=str(sockets[0]), WAYLAND_DISPLAY=displays[0].name)
        (artifacts / "compositor.json").write_text(json.dumps({"pid": compositor.pid, "outputs": outputs, "environment": {key: proc_env.get(key) for key in ["WLR_BACKENDS", "WLR_RENDERER", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME"]}}, indent=2))
        # wtype compiles every queued symbol before executing any action.
        # Sleep first: the populated keyboard sends no keys during the suite;
        # teardown ends it before any queued seed character can execute.
        alphabet = "".join(chr(value) for value in range(32, 127))
        keyboard_args = ["wtype", "-s", "600000", alphabet]
        for key in ["Control_L", "Shift_L", "Alt_L", "Super_L"]:
            keyboard_args.extend(["-P", key, "-p", key])
        for key in ["Return", "Escape", "Tab", "BackSpace", "Up", "Down", "Left", "Right"] + [f"F{value}" for value in range(1, 13)]:
            keyboard_args.extend(["-k", key])
        keyboard = subprocess.Popen(keyboard_args, env=native_env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if keyboard.poll() is not None:
                    raise RuntimeError("Owned virtual keyboard exited before native qualification")
                inputs = json.loads(subprocess.check_output([swaymsg, "-s", str(sockets[0]), "-t", "get_inputs", "-r"], text=True))
                if any(value.get("type") == "keyboard" for value in inputs) and Path(f"/proc/{keyboard.pid}/wchan").read_text().strip() in ["hrtimer_nanosleep", "do_nanosleep"]:
                    break
                time.sleep(.05)
            else:
                raise RuntimeError("Private compositor keyboard readiness timed out")
            keyboard_env = dict(value.split("=", 1) for value in Path(f"/proc/{keyboard.pid}/environ").read_text().split("\0") if "=" in value)
            for key in ["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME"]:
                if keyboard_env.get(key) != native_env[key]:
                    raise RuntimeError(f"Owned virtual keyboard lost private {key}")
            (artifacts / "keyboard.json").write_text(json.dumps({"pid": keyboard.pid, "inputs": inputs, "environment": {key: keyboard_env.get(key) for key in ["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME"]}}, indent=2))
            subprocess.run(["bunx", "wdio", "run", "e2e-tauri/wdio.scaled-selection.conf.ts"], cwd=root, env=native_env, check=True)
        finally:
            keyboard.terminate()
            keyboard.wait(timeout=5)
    finally:
        compositor.terminate()
        try:
            compositor.wait(timeout=5)
        except subprocess.TimeoutExpired:
            compositor.kill()
            compositor.wait()
