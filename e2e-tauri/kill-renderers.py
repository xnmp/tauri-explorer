"""Signal only verified test renderers through pinned Linux process handles."""
import json
import os
from pathlib import Path
import signal
import sys


def stat(pid):
    value = Path(f"/proc/{pid}/stat").read_text()
    fields = value[value.rfind(")") + 1:].split()
    return {"parent": int(fields[1]), "start": fields[19]}


def executable(pid):
    return os.readlink(f"/proc/{pid}/exe")


def environment(pid):
    return set(Path(f"/proc/{pid}/environ").read_bytes().decode().split("\0"))


def belongs_to(pid, root):
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        pid = stat(pid)["parent"]
        if pid == root:
            return True
    return False


def terminate(request):
    root = request["applicationPid"]
    expected_env = request["environment"]
    if not expected_env.get("XDG_CONFIG_HOME"):
        raise ValueError("An isolated XDG_CONFIG_HOME is required")
    handles = []
    try:
        root_handle = os.pidfd_open(root)
        handles.append(root_handle)
        signal.pidfd_send_signal(root_handle, 0)
        if (stat(root)["start"] != request["applicationStart"]
                or executable(root) != request["applicationExecutable"]
                or not {f"{key}={value}" for key, value in expected_env.items()} <= environment(root)):
            raise ValueError("Native application identity changed")
        targets = request["renderers"]
        if not targets or len({target["pid"] for target in targets}) != len(targets):
            raise ValueError("Renderer targets must be nonempty and distinct")
        renderer_handles = []
        for target in targets:
            pid = target["pid"]
            # Open first, then verify the process. Subsequent signalling uses
            # this handle even if the numeric PID exits and is later recycled.
            handle = os.pidfd_open(pid)
            handles.append(handle)
            signal.pidfd_send_signal(handle, 0)
            if (stat(pid)["start"] != target["start"]
                    or Path(executable(pid)).name != "WebKitWebProcess"
                    or not belongs_to(pid, root)):
                raise ValueError("Renderer is not the verified test descendant")
            renderer_handles.append(handle)
        # A dead/replaced parent must not authorize signals to another family.
        signal.pidfd_send_signal(root_handle, 0)
        if stat(root)["start"] != request["applicationStart"]:
            raise ValueError("Native application exited during verification")
        for handle in renderer_handles:
            signal.pidfd_send_signal(handle, signal.SIGKILL)
        return [target["pid"] for target in targets]
    finally:
        for handle in handles:
            os.close(handle)


if __name__ == "__main__":
    print(json.dumps(terminate(json.loads(sys.argv[1]))))
