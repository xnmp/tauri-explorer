from pathlib import Path
import json, os, signal, subprocess, time
root = Path.cwd() / 'qualification-results' / os.environ.get('PROBE_PROFILE', 'wry-private')
root.mkdir(parents=True, exist_ok=True)
for name in ['config', 'cache', 'data', 'runtime']:
    (root/name).mkdir(exist_ok=True)
(root/'runtime').chmod(0o700)
ready, gate = root/'ready', root/'go'
for path in [ready, gate]:
    path.unlink(missing_ok=True)
xf_log = (root/'xvfb.log').open('w')
xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=xf_log, text=True, start_new_session=True)
run = None
try:
    display = ':' + xvfb.stdout.readline().strip()
    assert display != ':'
    env = dict(os.environ, DISPLAY=display, GDK_BACKEND='x11', XDG_CONFIG_HOME=str(root/'config'), XDG_CACHE_HOME=str(root/'cache'), XDG_DATA_HOME=str(root/'data'), XDG_RUNTIME_DIR=str(root/'runtime'), XDG_CURRENT_DESKTOP='Openbox', XDG_SESSION_DESKTOP='Openbox', XDG_SESSION_TYPE='x11', NO_AT_BRIDGE='1', PROBE_READY=str(ready), PROBE_GO=str(gate))
    for name in ['WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'SWAYSOCK', 'DBUS_SESSION_BUS_ADDRESS']:
        env.pop(name, None)
    with (root/'churn.log').open('w') as log:
        run = subprocess.Popen(['dbus-run-session', '--', 'sh', '-c', 'openbox > "$XDG_CACHE_HOME/openbox.log" 2>&1 & exec "$1"', 'private-wry', str(Path.cwd()/os.environ.get('PROBE_BINARY', 'qualification-results/wry-ipc-churn'))], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 45
        while not ready.exists() and run.poll() is None and time.monotonic() < deadline:
            time.sleep(0.1)
        assert ready.exists(), 'probe failed before environment verification; inspect churn.log'
        descendants = {run.pid}
        rows = {}
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit(): continue
            try:
                values = (entry/'stat').read_text().split(') ',1)[1].split()
                rows[int(entry.name)] = int(values[1])
            except (FileNotFoundError, ProcessLookupError, PermissionError): pass
        changed = True
        while changed:
            changed = False
            for pid, parent in rows.items():
                if parent in descendants and pid not in descendants:
                    descendants.add(pid); changed = True
        audit = []
        for pid in sorted(descendants):
            try:
                raw = Path(f'/proc/{pid}/environ').read_bytes()
                values = dict(value.decode().split('=',1) for value in raw.split(b'\0') if b'=' in value)
                command = Path(f'/proc/{pid}/comm').read_text().strip()
            except (FileNotFoundError, ProcessLookupError, PermissionError): continue
            assert values.get('DISPLAY') == display, (pid, command, 'wrong DISPLAY')
            assert values.get('GDK_BACKEND') == 'x11', (pid, command, 'wrong GDK_BACKEND')
            assert 'WAYLAND_DISPLAY' not in values
            assert values.get('XDG_RUNTIME_DIR') == str(root/'runtime')
            if command not in {'dbus-run-sessio', 'dbus-daemon'}:
                assert values.get('DBUS_SESSION_BUS_ADDRESS'), (pid, command, 'missing private bus')
                assert values.get('DBUS_SESSION_BUS_ADDRESS') != os.environ.get('DBUS_SESSION_BUS_ADDRESS')
            audit.append({'pid':pid,'command':command,'display':values['DISPLAY'],'backend':values['GDK_BACKEND'],'wayland':False,'runtime':values['XDG_RUNTIME_DIR']})
        assert any(item['pid'] == int(ready.read_text()) for item in audit)
        (root/'environment-audit.json').write_text(json.dumps(audit, indent=2)+'\n')
        print(f'Private display {display}; verified {len(audit)} processes before 450-cycle run', flush=True)
        gate.touch()
        code = run.wait(timeout=600)
        report = (root/'churn.log').read_text()
        print(report if code else '\n'.join(line for line in report.splitlines() if line.startswith(('pid=', 'cycle=', 'PASS'))), flush=True)
        assert code == 0, f'probe exited {code}'
finally:
    for process in [run, xvfb]:
        if process is None: continue
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait(timeout=5)
    xf_log.close()
