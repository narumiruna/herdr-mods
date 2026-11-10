"""Explicit offline self-update for a clean official Git installation. Standard library only."""

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile


SOURCE = "https://github.com/narumiruna/herdr-mods.git"
# Existing checkout origins remain valid after the repository rename.
ORIGINS = {
    SOURCE, SOURCE.removesuffix(".git"), "git@github.com:narumiruna/herdr-mods.git",
    "https://github.com/narumiruna/herdr-mod-manager.git",
    "https://github.com/narumiruna/herdr-mod-manager",
    "git@github.com:narumiruna/herdr-mod-manager.git",
}
COMMIT = re.compile(r"[0-9a-f]{40}")
LOCK = "herdr-self-update.lock"
NOTICE = "Files verified. Reopen Herdr to load the update; runtime success is not verified."
RECOVERY = "Keep Herdr stopped. Preserve the checkout and Git metadata; inspect git status and both commits. Do not reset, clean, delete locks, or force a retry."


class UpdateError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise UpdateError(message)


def stamp(path):
    info = path.lstat()
    return info.st_dev, info.st_ino


def walk_error(error):
    raise error


class Updater:
    def __init__(self, script):
        require(sys.platform in {"darwin", "linux"}, "Self-update supports macOS and Linux only")
        require(sys.version_info >= (3, 9), "Python 3.9 or newer is required")
        manager = Path(script).resolve(strict=True).parent
        self.root = manager
        # Accept only a flat checkout or the exact monorepo package location.
        # Never discover a repository by searching arbitrary ancestors.
        if not (manager / ".git").exists() and not (manager / ".git").is_symlink():
            if manager.name == "mod-manager" and manager.parent.name == "mods":
                self.root = manager.parent.parent
        self.gitdir = self.root / ".git"
        self.identities = {}
        for path in [*reversed(manager.parents), manager, self.gitdir]:
            require(stat.S_ISDIR(path.lstat().st_mode), f"Real directory required: {path}; linked worktrees and packages are unsupported")
            self.identities[path] = stamp(path)
        self.git = shutil.which("git")
        require(self.git, "Install a trusted Git separately; no tools are downloaded")
        self.env = {
            "PATH": os.environ.get("PATH", os.defpath), "HOME": "/nonexistent", "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/usr/bin/false",
            "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_ATTR_NOSYSTEM": "1",
        }
        self.options = [
            "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            "-c", "core.attributesFile=/dev/null", "-c", "credential.helper=",
            "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
            "-c", "http.followRedirects=false", "-c", "http.sslVerify=true",
            "-c", "gc.auto=0", "-c", "maintenance.auto=false",
        ]
        self.configured = False

    def _identity(self):
        for path, expected in self.identities.items():
            require(stat.S_ISDIR(path.lstat().st_mode) and stamp(path) == expected, f"Installation directory changed: {path}")

    def _command(self, args, cwd):
        self._identity()
        result = subprocess.run(
            [self.git, *self.options, *args], cwd=cwd, env=self.env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=120, check=False,
        )
        require(result.returncode == 0, "Git failed: " + result.stderr.decode("utf-8", "replace")[-2000:].strip())
        return result.stdout

    def _git(self, *args):
        require(self.configured, "Git configuration must be verified first")
        return self._command(list(args), self.root)

    def _metadata(self, allow_locks=False):
        self._identity()
        forbidden = {"commondir", "gitdir", "shallow", "config.worktree", "objects/info/alternates", "objects/info/http-alternates", "info/grafts", "refs/replace", "info/sparse-checkout", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer"}
        for name in forbidden:
            require(not (self.gitdir / name).exists() and not (self.gitdir / name).is_symlink(), f"Unsupported or active Git metadata: {name}")
        for parent, dirs, files in os.walk(self.gitdir, followlinks=False, onerror=walk_error):
            for name in dirs + files:
                path = Path(parent) / name
                info = path.lstat()
                require(stat.S_ISDIR(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1), f"Linked or unsafe Git metadata: {path}")
                require(allow_locks or not name.endswith(".lock") or path == self.gitdir / LOCK, f"Active Git lock: {path}")
        attributes = self.gitdir / "info/attributes"
        require(not attributes.exists() or not attributes.read_bytes(), "Local Git attributes are unsupported")
        packed = self.gitdir / "packed-refs"
        require(not packed.exists() or b" refs/replace/" not in packed.read_bytes(), "Replacement refs are unsupported")

    def _config(self):
        # Run outside the checkout. Do not expand includes or load repository config.
        raw = self._command(["config", "--file", str(self.gitdir / "config"), "--no-includes", "--null", "--list"], "/")
        allowed = {"core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase", "core.precomposeunicode", "core.hookspath", "remote.origin.url", "remote.origin.fetch", "user.name", "user.email"}
        values = {}
        for item in raw.decode("utf-8").split("\0"):
            if not item:
                continue
            key, _, value = item.partition("\n")
            require(key in allowed or re.fullmatch(r"branch\..+\.(remote|merge|vscode-merge-base|github-pr-owner-number)", key), f"Unsupported local Git setting: {key}; includes, filters, attributes and URL rewrites are not allowed")
            values.setdefault(key, []).append(value)
        require(values.get("core.repositoryformatversion") == ["0"] and values.get("core.bare") == ["false"], "An ordinary non-bare Git checkout is required")
        require(len(values.get("remote.origin.url", [])) == 1 and values["remote.origin.url"][0] in ORIGINS, "The origin must identify the official Herdr Mod Manager repository")
        self.configured = True

    def _tree(self, cwd, revision):
        tree = {}
        folded = {}
        total = 0
        raw = self._command(["ls-tree", "-r", "-l", "-z", "--full-tree", revision], cwd)
        for item in raw.split(b"\0"):
            if not item:
                continue
            header, raw_path = item.split(b"\t", 1)
            mode, kind, blob, size = header.decode("ascii").split()
            path = raw_path.decode("utf-8")
            names = path.split("/")
            require(all(name and name.isascii() and all(" " <= char < "\x7f" for char in name) and name not in {".", ".."} and name.casefold() != ".git" and ":" not in name and "\\" not in name for name in names), f"Unsafe source path: {path}; only printable ASCII paths are supported")
            require(names[-1].casefold() != ".gitattributes", "Git attributes are unsupported for self-update")
            require(mode in {"100644", "100755"} and kind == "blob", f"Unsafe source tree mode: {path}; symlinks and submodules are unsupported")
            # Include directory names: A/x and a/y also collide on macOS.
            for index in range(1, len(names) + 1):
                prefix = "/".join(names[:index])
                require(folded.get(prefix.casefold(), prefix) == prefix, f"Case-conflicting source path: {path}")
                folded[prefix.casefold()] = prefix
            total += int(size)
            require(len(tree) < 10000 and int(size) <= 8 * 1024 * 1024 and total <= 128 * 1024 * 1024, "Source tree exceeds self-update limits")
            tree[path] = (mode, blob)
        # Select the layout for each revision, including flat-to-monorepo updates.
        # A partial nested package must not fall back to flat manager files.
        prefix = "mods/mod-manager/" if any(name.startswith("mods/mod-manager/") for name in tree) else ""
        for name in ["mod.json", "main.js", "manager.js", "runtime.js", "operations.py", "self_update.py"]:
            require(prefix + name in tree, f"Incomplete manager source: {prefix}{name}")
        manifest = json.loads(self._command(["cat-file", "blob", tree[prefix + "mod.json"][1]], cwd))
        require(isinstance(manifest, dict), f"{prefix}mod.json must be an object")
        for name in ["main.js", "manager.js", "runtime.js", "operations.py", "self_update.py"]:
            require(self._command(["cat-file", "blob", tree[prefix + name][1]], cwd).decode("utf-8").strip(), f"Empty manager source: {prefix}{name}")
        return tree

    def _verify_files(self, tree):
        expected_dirs = {str(parent) for name in tree for parent in Path(name).parents if str(parent) != "."}
        actual_files = set()
        for parent, dirs, files in os.walk(self.root, followlinks=False, onerror=walk_error):
            if Path(parent) == self.root:
                dirs.remove(".git")
            for name in dirs:
                path = Path(parent) / name
                require(stat.S_ISDIR(path.lstat().st_mode) and str(path.relative_to(self.root)) in expected_dirs, f"Unexpected or linked working directory: {path}")
            actual_files.update(str((Path(parent) / name).relative_to(self.root)) for name in files)
        require(actual_files == set(tree), "Unexpected or missing working files block self-update")
        snapshot = {}
        for name, (mode, blob) in tree.items():
            path = self.root / name
            for parent in path.parents:
                if parent == self.root:
                    break
                require(stat.S_ISDIR(parent.lstat().st_mode), f"Unsafe working directory: {parent}")
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, f"Linked or unsafe working file: {name}")
            data = path.read_bytes()
            require(data == self._git("cat-file", "blob", blob) and bool(info.st_mode & 0o111) == (mode == "100755"), f"Local file changes: {name}")
            snapshot[name] = (info.st_dev, info.st_ino, stat.S_IMODE(info.st_mode), hashlib.sha256(data).hexdigest())
        return snapshot

    def _local(self):
        self._metadata()
        self._config()
        require(self._git("symbolic-ref", "--quiet", "HEAD").strip() == b"refs/heads/main", "Self-update requires the main branch; detached HEAD and development branches are unsupported")
        require(not self._git("status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"), "Local changes, untracked or ignored files block self-update; preserve them outside the checkout first")
        require(all(entry.startswith(b"H ") for entry in self._git("ls-files", "-v", "-z").split(b"\0") if entry), "Hidden index flags (skip-worktree or assume-unchanged) are unsupported")
        head = self._git("rev-parse", "--verify", "HEAD^{commit}").decode().strip()
        require(COMMIT.fullmatch(head), "A SHA-1 installation commit is required")
        tree = self._tree(self.root, head)
        return head, self._verify_files(tree)

    def _clone(self, destination):
        # The only production transport is the fixed public HTTPS repository.
        self._command(["clone", "--bare", "--no-local", "--no-tags", "--single-branch", "--branch", "main", "--template=", "--", SOURCE, str(destination)], destination.parent)

    @contextlib.contextmanager
    def _candidate(self, installed):
        with tempfile.TemporaryDirectory(prefix="herdr-self-update-") as folder:
            repo = Path(folder) / "source.git"
            self._clone(repo)
            target = self._command(["rev-parse", "--verify", "refs/heads/main^{commit}"], repo).decode().strip()
            require(COMMIT.fullmatch(target), "The official main must identify a SHA-1 commit")
            tree = self._tree(repo, target)
            self._command(["merge-base", "--is-ancestor", installed, target], repo)
            yield repo, target, tree

    def check(self):
        installed, _ = self._local()
        with self._candidate(installed) as (_, target, _):
            require(self._local()[0] == installed, "Installation changed during the check")
            return {"ok": True, "path": str(self.root), "source": SOURCE, "branch": "main", "installedCommit": installed, "targetCommit": target, "updateAvailable": installed != target}

    def _stopped(self):
        result = subprocess.run(["ps", "-axo", "pid=,comm="], env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        require(result.returncode == 0, "Cannot verify stopped Herdr processes")
        lines = result.stdout.decode("utf-8").splitlines()
        require(lines, "Process evidence is empty")
        for line in lines:
            fields = line.strip().split(None, 1)
            require(len(fields) == 2 and fields[0].isdigit() and fields[1].strip() and "\0" not in fields[1], "Malformed process evidence; cannot verify stopped Herdr")
            require(Path(fields[1].strip()).name.lower() not in {"herdr", "herdr-app"}, "Herdr is running. Fully quit all Herdr app instances and use an external terminal")

    @contextlib.contextmanager
    def _lock(self):
        import fcntl
        path = self.gitdir / LOCK
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stamp(path) == (info.st_dev, info.st_ino), "Unsafe self-update lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise UpdateError("Another self-update is in progress") from error
            def verify_lock():
                current = path.lstat()
                require(stat.S_ISREG(current.st_mode) and current.st_nlink == 1 and stamp(path) == (info.st_dev, info.st_ino), "Self-update lock identity changed")
            yield verify_lock
            verify_lock()
        finally:
            os.close(fd)  # Persistent inode: never unlink a lifecycle lock.

    def _merge(self, target):
        self._git("merge", "--ff-only", "--no-edit", "--no-autostash", "--no-overwrite-ignore", target)

    def apply(self, expected_path, installed, target, app_stopped):
        require(app_stopped, "Apply requires --app-stopped after a full Herdr quit")
        require(expected_path == str(self.root), "The resolved installation path changed; check again and confirm --expected-path")
        require(isinstance(installed, str) and COMMIT.fullmatch(installed) and isinstance(target, str) and COMMIT.fullmatch(target), "Both confirmed commits must be 40-character lowercase hexadecimal hashes")
        self._stopped()
        self._metadata()
        self._config()
        with self._lock() as verify_lock:
            current, before = self._local()
            require(current == installed, "Installed commit changed; run check again")
            with self._candidate(installed) as (repo, candidate, tree):
                require(candidate == target, "Official main changed since check; run check again")
                # Transfer only the verified private clone, not a configured remote or supplied URL.
                self._git("-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", str(repo), target)
                require(self._local() == (installed, before), "Installation files changed before apply")
                self._stopped()
                verify_lock()
                if installed != target:
                    self._merge(target)
                require(self._local()[0] == target, "Final installed commit verification failed")
                self._verify_files(tree)
        return {"ok": True, "path": str(self.root), "previousCommit": installed, "installedCommit": target, "restartRequired": installed != target, "message": NOTICE}

    def failure_state(self):
        result = {"path": str(self.root)}
        if self.configured:
            for key, args in [("currentCommit", ["rev-parse", "--verify", "HEAD^{commit}"]), ("workingState", ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"])]:
                try:
                    self._metadata(allow_locks=True)
                    self._config()
                    result[key] = self._git(*args).decode("utf-8", "replace").strip()
                except (UpdateError, OSError, subprocess.SubprocessError, ValueError) as error:
                    result[key] = "Unverified: " + str(error)
        return result


def main(argv=None, script=__file__):
    parser = argparse.ArgumentParser(description="Check official main, then update this clean Git installation with Herdr fully stopped. No automatic or live updates.")
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("check", help="Report the resolved path and installed/candidate commits without changing the installation")
    apply = commands.add_parser("apply", help="Apply only the path and commits reported by check")
    apply.add_argument("--expected-path", required=True)
    apply.add_argument("--expected-commit", required=True)
    apply.add_argument("--target-commit", required=True)
    apply.add_argument("--app-stopped", action="store_true", help="Confirm all Herdr apps are fully quit; do not restart until success or recovery")
    args = parser.parse_args(argv)
    updater = None
    try:
        updater = Updater(script)
        result = updater.check() if args.action == "check" else updater.apply(args.expected_path, args.expected_commit, args.target_commit, args.app_stopped)
    except (UpdateError, OSError, subprocess.SubprocessError, UnicodeError, ValueError) as error:
        result = {"ok": False, "error": str(error), "recovery": RECOVERY}
        if args.action == "apply":
            result.update(previousCommit=args.expected_commit, targetCommit=args.target_commit)
        if updater is not None:
            result.update(updater.failure_state())
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
