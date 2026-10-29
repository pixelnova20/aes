#!/usr/bin/env python3
"""Restore a legacy AES MySQL bind mount to system storage without deleting data."""
import os
import pathlib
import shutil
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
if os.geteuid() != 0:
    raise SystemExit("Run with sudo. Stop AES application services before restoring MySQL storage.")
source = root / "production-data/courseworks/mysql"
target = pathlib.Path("/var/lib/mysql")
if source.exists() and subprocess.run(["mountpoint", "-q", str(target)]).returncode == 0:
    if not os.path.samefile(source, target):
        raise SystemExit("MySQL mount does not belong to this AES installation.")
    configs = [pathlib.Path("/etc/systemd/system/var-lib-mysql.mount"), pathlib.Path("/etc/systemd/system/mysql.service.d/aes-storage.conf")]
    saved = {p: p.read_bytes() for p in configs}
    subprocess.run(["systemctl", "stop", "mysql.service"], check=True)
    moved = False
    try:
        subprocess.run(["systemctl", "disable", "--now", "var-lib-mysql.mount"], check=True)
        target.rmdir()
        shutil.move(str(source), str(target))
        moved = True
        for p in configs:
            p.unlink()
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "start", "mysql.service"], check=True)
    except BaseException:
        subprocess.run(["systemctl", "stop", "mysql.service"], check=True)
        if moved:
            shutil.move(str(target), str(source))
        target.mkdir(exist_ok=True)
        for p, content in saved.items():
            p.write_bytes(content)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "enable", "--now", "var-lib-mysql.mount"], check=True)
        subprocess.run(["systemctl", "start", "mysql.service"], check=True)
        raise
    print("MySQL data restored to /var/lib/mysql; no database contents were deleted.")
elif source.exists():
    raise SystemExit("Legacy MySQL data exists without its expected mount; inspect manually before continuing.")
