"""Sample AES systemd cgroups; expire inactive application logs after 30 days."""
import os
import subprocess
import time
from pathlib import Path

from aes_logging import emit

SERVICES = ("courseworks-backend.service", "homework.service", "slideshow.service", "mysql.service")


def sample():
    for service in SERVICES:
        try:
            group = subprocess.check_output(["systemctl", "show", service, "-p", "ControlGroup", "--value"], text=True, timeout=3).strip()
            if not group or not group.startswith("/"):
                continue
            root = Path("/sys/fs/cgroup") / group.lstrip("/")
            values = {}
            for name in ("cpu.stat", "memory.current", "memory.peak", "memory.events", "io.stat", "pids.current"):
                file = root / name
                if file.is_file():
                    values[name] = file.read_text().strip()
            emit("system", "service_resource_sample", channel="resources", unit=service, counters=values)
        except (OSError, subprocess.SubprocessError):
            emit("system", "service_sample_failed", channel="resources", unit=service)


def expire_logs():
    root = Path(os.environ["AES_LOG_ROOT"])
    cutoff = time.time() - 30 * 86400
    for channel in ("operations", "auth", "resources"):
        for file in (root / channel).glob("*.jsonl*"):
            if file.is_file() and not file.is_symlink() and file.stat().st_mtime < cutoff:
                file.unlink()


if __name__ == "__main__":
    iteration = 0
    while True:
        sample()
        if iteration % 240 == 0:
            try:
                expire_logs()
            except OSError:
                emit("system", "log_retention_failed", channel="resources")
        iteration += 1
        time.sleep(15)
