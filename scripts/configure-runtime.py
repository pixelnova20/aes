#!/usr/bin/env python3
"""Consolidate a dedicated AES host's data, with offline backup and rollback."""
import argparse
import datetime
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import tarfile


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parents[1]))
    parser.add_argument("--user", default=os.environ.get("SUDO_USER"))
    args = parser.parse_args()
    if os.geteuid() != 0 or not args.user or args.user == "root":
        raise SystemExit("Run with sudo and --user <AES service account>.")
    root = pathlib.Path(args.root).resolve()
    if any(c.isspace() for c in str(root)) or "%" in str(root):
        raise SystemExit("The AES path must not contain whitespace or percent signs.")
    user = pwd.getpwnam(args.user)
    data, logs = root / "production-data", root / "logs"
    env_file = root / "courseworks/.env"
    if not env_file.is_file():
        raise SystemExit("Create courseworks/.env with install_script.sh first.")
    if (data / "courseworks/mysql").exists():
        raise SystemExit("Restore legacy MySQL storage with scripts/release-mysql-storage.py before configuring application data.")
    services = ["courseworks-backend.service", "homework.service", "slideshow.service"]
    active = [s for s in services + ["aes-resource-monitor.service"] if subprocess.run(["systemctl", "is-active", "--quiet", s]).returncode == 0]
    data.mkdir(exist_ok=True, mode=0o700)
    os.chown(data, user.pw_uid, user.pw_gid)
    backup = data / "backups" / ("storage-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir(parents=True, mode=0o700)
    for p in (data, backup.parent, backup):
        p.chmod(0o700)
        os.chown(p, user.pw_uid, user.pw_gid)
    old_env = env_file.read_text()
    saved_configs = {}
    moved = []
    aliases = []
    workspace_paths_updated = False

    def config(file, text):
        file = pathlib.Path(file)
        if str(file) not in saved_configs:
            saved_configs[str(file)] = file.read_text() if file.exists() else None
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def directory(p, owner=user.pw_uid, group=user.pw_gid):
        p.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(p, owner, group)
        p.chmod(p.stat().st_mode | 0o700)

    def move(source, target, alias=False):
        if not source.exists() or source.is_symlink():
            return
        if source.is_dir() and not any(p.name != ".gitkeep" for p in source.iterdir()):
            return
        if target.exists():
            if target.is_dir() and not any(target.iterdir()):
                target.rmdir()
            else:
                raise RuntimeError(f"Refusing to overwrite {target}")
        directory(target.parent)
        shutil.move(str(source), str(target))
        moved.append((source, target))
        if alias:
            source.symlink_to(os.path.relpath(target, source.parent), target_is_directory=True)
            aliases.append(source)

    try:
        print("Stopping AES for application data backup; MySQL stays in system storage.", flush=True)
        run("systemctl", "stop", *services)
        subprocess.run(["systemctl", "stop", "aes-resource-monitor.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        dump = backup / "mysql.sql"
        with dump.open("wb") as output:
            dump.chmod(0o600)
            os.chown(dump, user.pw_uid, user.pw_gid)
            subprocess.run(["mysqldump", "--single-transaction", "--routines", "--events", "--triggers", "--databases", "vibeos_agent"], stdout=output, check=True)
        with tarfile.open(backup / "before-migration.tar.gz", "w:gz") as archive:
            archive.add(env_file, arcname="courseworks/.env")
            for name in ["accounts-data", "archive-data", "homeworks/uploads", "slideshow/uploads", "courseworks/student-workspace", "courseworks/logs"]:
                if (root / name).exists() and not (root / name).is_symlink():
                    archive.add(root / name, arcname=name)
            for name in ("accounts", "homeworks", "slideshow", "courseworks", "archives"):
                if (data / name).exists():
                    archive.add(data / name, arcname="production-data/" + name)
        for old, new, alias in [
            ("accounts-data", "accounts", False),
            ("homeworks/uploads", "homeworks/uploads", True),
            ("slideshow/uploads", "slideshow/uploads", True),
            ("courseworks/student-workspace", "courseworks/workspaces", True),
            ("archive-data", "archives", False),
        ]:
            move(root / old, data / new, alias)
        for filename, subdir in [("courses.db", "homeworks"), ("slideshow.db", "slideshow")]:
            for suffix in ("", "-wal", "-shm", "-journal"):
                move(data / "accounts" / (filename + suffix), data / subdir / (filename + suffix))
        if (root / "courseworks/logs").exists() and not (root / "courseworks/logs").is_symlink():
            move(root / "courseworks/logs", logs / "legacy-courseworks", True)
        for name in ["accounts", "homeworks/uploads", "slideshow/uploads", "courseworks/workspaces", "archives"]:
            directory(data / name)
        for name in ["auth", "operations", "resources", "runtime", "courseworks"]:
            directory(logs / name)
        os.chown(logs, user.pw_uid, user.pw_gid)
        changes = {
            "AES_ROOT": str(root), "AES_DATA_ROOT": str(data), "AES_LOG_ROOT": str(logs),
            "HOMEWORKS_ACCOUNT_DATABASE_PATH": str(data / "accounts/accounts.db"),
            "HOMEWORKS_COURSE_DATABASE_PATH": str(data / "homeworks/courses.db"),
            "HOMEWORKS_UPLOAD_PATH": str(data / "homeworks/uploads"),
            "UPLOAD_DIR": str(data / "homeworks/uploads"),
            "SLIDESHOW_DATABASE_PATH": str(data / "slideshow/slideshow.db"),
            "SLIDESHOW_UPLOAD_PATH": str(data / "slideshow/uploads"),
            "ARCHIVE_ROOT": str(data / "archives"), "WORKSPACE_ROOT": str(data / "courseworks/workspaces"),
        }
        lines = [line for line in old_env.splitlines() if line.partition("=")[0] not in changes and not line.startswith("EXECUTION_RESOURCE_LOG_DIR=")]
        env_file.write_text("\n".join(lines + [k + "=" + json.dumps(v) for k, v in changes.items()]) + "\n")
        env_file.chmod(0o600)
        os.chown(env_file, user.pw_uid, user.pw_gid)
        # EnvironmentFile takes priority over older per-service log directory overrides.
        for service in services:
            for stream in ("stdout", "stderr"):
                p = logs / "runtime" / f"{service}.{stream}.log"
                p.touch(mode=0o600, exist_ok=True)
                os.chown(p, user.pw_uid, user.pw_gid)
            config(f"/etc/systemd/system/{service}.d/storage-logging.conf", f"[Service]\nUMask=0077\nEnvironment=AES_ROOT={root}\nEnvironment=AES_DATA_ROOT={data}\nEnvironment=AES_LOG_ROOT={logs}\nEnvironment=PYTHONPATH={root / 'management'}\nStandardOutput=append:{logs}/runtime/{service}.stdout.log\nStandardError=append:{logs}/runtime/{service}.stderr.log\n")
            if service != "courseworks-backend.service":
                file = pathlib.Path(f"/etc/systemd/system/{service}.d/storage-logging.conf")
                # %U is the URL path only; Gunicorn's default request line includes SSO tokens.
                file.write_text(file.read_text() + 'Environment="GUNICORN_CMD_ARGS=--access-logformat \'%%(m)s %%(U)s %%(s)s %%(L)s\'"\n')
        old_resource_config = pathlib.Path("/etc/systemd/system/courseworks-backend.service.d/resource-management.conf")
        if old_resource_config.exists():
            config(old_resource_config, "\n".join(line for line in old_resource_config.read_text().splitlines() if "EXECUTION_RESOURCE_LOG_DIR=" not in line) + "\n")
        config("/etc/systemd/system/aes-resource-monitor.service", f"[Unit]\nDescription=AES service resource telemetry\nAfter=courseworks-backend.service\n\n[Service]\nUser={args.user}\nWorkingDirectory={root}\nEnvironment=AES_LOG_ROOT={logs}\nExecStart=/usr/bin/python3 {root}/management/resource_monitor.py\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n")
        config("/etc/logrotate.d/aes", f"{logs}/runtime/*.log {logs}/courseworks/*.log {{\n    daily\n    maxsize 20M\n    rotate 14\n    missingok\n    notifempty\n    compress\n    copytruncate\n    su {args.user} {run('id', '-gn', args.user)}\n}}\n")
        (backup / "service-configs.json").write_text(json.dumps(saved_configs))
        # Never follow student-created symlinks outside the application data tree.
        for parent, dirs, files in os.walk(data, followlinks=False):
            for p in [pathlib.Path(parent)] + [pathlib.Path(parent) / n for n in dirs + files]:
                if not p.is_symlink():
                    os.chown(p, user.pw_uid, user.pw_gid)
                    p.chmod((p.stat().st_mode & 0o777) | (0o700 if p.is_dir() else 0o600))
        for p in backup.iterdir():
            p.chmod(0o600)
        run("systemctl", "daemon-reload")
        # Existing saved absolute paths are also kept valid by workspace/upload aliases.
        old = str(root / "courseworks/student-workspace").replace("'", "''")
        new = str(data / "courseworks/workspaces").replace("'", "''")
        tables = run("mysql", "-N", "vibeos_agent", "-e", "SHOW TABLES").splitlines()
        if "workspaces" in tables:
            run("mysql", "vibeos_agent", "-e", f"UPDATE workspaces SET path=CONCAT('{new}',SUBSTRING(path,{len(old)+1})) WHERE path LIKE '{old}/%';")
            workspace_paths_updated = True
        run("systemctl", "enable", "--now", "aes-resource-monitor.service")
        for service in active:
            run("systemctl", "start", service)
        print(f"Storage and logs configured. Offline backup: {backup}")
    except BaseException:
        print("Migration failed; restoring directories, environment and service configuration.", flush=True)
        subprocess.run(["systemctl", "stop", *services, "aes-resource-monitor.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for alias in aliases:
            alias.unlink(missing_ok=True)
        for source, target in reversed(moved):
            if source.is_dir() and not any(source.iterdir()):
                source.rmdir()
            shutil.move(str(target), str(source))
        env_file.write_text(old_env)
        for file, content in saved_configs.items():
            if content is None:
                pathlib.Path(file).unlink(missing_ok=True)
            else:
                pathlib.Path(file).write_text(content)
        run("systemctl", "daemon-reload")
        if workspace_paths_updated:
            run("mysql", "vibeos_agent", "-e", f"UPDATE workspaces SET path=CONCAT('{old}',SUBSTRING(path,{len(new)+1})) WHERE path LIKE '{new}/%';")
        for service in active:
            run("systemctl", "start", service)
        raise


if __name__ == "__main__":
    main()
