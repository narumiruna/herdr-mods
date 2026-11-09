#!/usr/bin/env python3
"""Optional, standard-library-only local lifecycle adapter. Never executes mod code.

The command writes exactly one JSON result. Operations owns only its registry,
transactions, staging files, and clean directories recorded in that registry.
An interrupted transaction blocks writes; it is never treated as an empty store.
"""

import contextlib
import ctypes
import errno
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import uuid

try:
    import fcntl
except ImportError:
    fcntl = None


class SafetyError(Exception):
    pass


NOTICE = (
    "Files were verified. This does not prove runtime unload or reload. "
    "A full app restart may be required; closing a window is not a full quit. "
    "The manager does not quit or restart Herdr."
)
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
REPOSITORY = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\Z")
COMMIT = re.compile(r"[0-9a-fA-F]{40}\Z")
LIMIT = 32 * 1024 * 1024
UNSPECIFIED = object()


def fail(message):
    raise SafetyError(message)


def identity(info):
    return [info.st_dev, info.st_ino]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rename_exclusive(source_fd, source, target_fd, target):
    """Atomic no-replace rename, including directories. Never use os.replace here."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function = getattr(libc, "renameatx_np", None)
        flag = 0x00000004  # RENAME_EXCL
    else:
        function = getattr(libc, "renameat2", None)
        flag = 1  # RENAME_NOREPLACE
    if function is None:
        fail("Unsupported platform: atomic no-replace rename is unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(source_fd, os.fsencode(source), target_fd, os.fsencode(target), flag):
        code = ctypes.get_errno()
        if code in {errno.ENOSYS, errno.EINVAL, errno.ENOTSUP}:
            fail("Unsupported filesystem: atomic no-replace rename is unavailable")
        raise OSError(code, os.strerror(code), target)


@contextlib.contextmanager
def close_fd(fd):
    try:
        yield fd
    finally:
        os.close(fd)


def parse_json(data, label):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail(f"Duplicate JSON key in {label}: {key}")
            result[key] = value
        return result

    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: fail(f"Invalid JSON in {label}"))
    except (ValueError, UnicodeError, RecursionError) as error:
        fail(f"Invalid JSON in {label}: {error}")


def encode(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True) + "\n").encode()


def valid_id(value):
    return isinstance(value, str) and bool(ID.fullmatch(value)) and value not in {".", ".."}


def parts(path, empty=False):
    if not isinstance(path, str) or (not path and not empty):
        fail("Expected a nonempty relative path")
    if not path and empty:
        return []
    result = path.split("/")
    if len(result) > 64 or len(path.encode("utf-8")) > 4096:
        fail("Path exceeds the safe depth or length limit")
    if any(not p or p in {".", ".."} or p.casefold() == ".git" or "\\" in p or any(ord(c) < 32 or ord(c) == 127 for c in p) for p in result):
        fail(f"Unsafe relative path: {path!r}")
    return result


def normalized_repository(value):
    if not isinstance(value, str) or not REPOSITORY.fullmatch(value) or value.endswith(".git"):
        fail("repository must be a public GitHub owner/repo, without a URL or .git suffix")
    owner, repo = value.split("/")
    if repo in {".", ".."}:
        fail("Unsafe repository")
    return f"{owner.lower()}/{repo.lower()}"


class SafeFS:
    """Pinned directories. All filesystem access below the anchor uses dirfd."""

    def __init__(self, path):
        if sys.version_info < (3, 9):
            fail("Cached Python 3.9 or newer is required; no interpreter is installed automatically")
        if os.name != "posix" or fcntl is None or not all(hasattr(os, name) for name in ("O_NOFOLLOW", "O_DIRECTORY", "fchdir")):
            fail("Unsupported platform: POSIX no-follow directory handles and flock are required")
        needed = (os.open, os.mkdir, os.stat, os.unlink, os.rmdir, os.rename, os.link)
        if any(func not in os.supports_dir_fd for func in needed) or any(func not in os.supports_follow_symlinks for func in (os.stat, os.link)):
            fail("Unsupported platform: safe dirfd/no-follow operations are unavailable")
        if not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path:
            fail("appHome must be an absolute normalized path without traversal")
        self.path = path
        self.chain = []
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.chain.append(("/", fd, identity(os.fstat(fd))))
        try:
            for part in path.split("/")[1:]:
                if not part:
                    continue
                fd = self.open_dir(fd, part)
                self.chain.append((part, fd, identity(os.fstat(fd))))
        except BaseException:
            self.close()
            raise
        self.root = fd

    def close(self):
        for _, fd, _ in reversed(self.chain):
            os.close(fd)
        self.chain = []

    def check(self):
        for index, (name, fd, expected) in enumerate(self.chain):
            parent = self.chain[index - 1][1] if index else None
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if identity(current) != expected or not stat.S_ISDIR(current.st_mode) or identity(os.fstat(fd)) != expected:
                fail("Unsafe ancestor swap detected; no further writes are allowed")

    @staticmethod
    def open_dir(parent, name):
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)

    @contextlib.contextmanager
    def directory(self, base, path, create=False):
        names = parts(path, empty=True)
        fd = os.dup(base)
        try:
            for name in names:
                if create:
                    try:
                        os.mkdir(name, 0o700, dir_fd=fd)
                        os.fsync(fd)
                    except FileExistsError:
                        pass
                child = self.open_dir(fd, name)
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def parent(self, base, path, create=False):
        names = parts(path)
        with self.directory(base, "/".join(names[:-1]), create=create) as fd:
            yield fd, names[-1]

    def read(self, base, path):
        with self.parent(base, path) as (parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
                    fail(f"Unsafe, linked, or oversized file: {path}")
                chunks = []
                length = 0
                while True:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    length += len(chunk)
                    if length > LIMIT:
                        fail(f"Oversized file: {path}")
                end = os.fstat(fd)
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if identity(current) != identity(info) or (end.st_size, end.st_mtime_ns, end.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
                    fail(f"File changed during read: {path}")
                return b"".join(chunks), info
            finally:
                os.close(fd)

    def exists(self, base, path):
        try:
            with self.parent(base, path) as (parent, name):
                os.stat(name, dir_fd=parent, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    def stamp(self, base, name):
        if not self.exists(base, name):
            return None
        data, info = self.read(base, name)
        return digest(data), identity(info)

    def retire(self, base, name, expected):
        """Retain a metadata preimage; never unlink an unchecked dentry."""
        saved = ".metadata-" + name + "-" + uuid.uuid4().hex
        self.check()
        rename_exclusive(base, name, base, saved)
        try:
            if self.stamp(base, saved) != expected:
                fail("Metadata preimage identity/content conflict: " + name)
            os.fsync(base)
        except BaseException as error:
            try:
                rename_exclusive(base, saved, base, name)
                os.fsync(base)
            except (OSError, SafetyError):
                pass
            fail(f"{error}; metadata/preimage retained at {name} or {saved}")
        return saved

    def atomic(self, base, name, data, expected=UNSPECIFIED):
        # Caller provenance is carried through move/verify/exclusive-publish.
        if len(data) > LIMIT:
            fail("Manager metadata exceeds the supported size limit")
        self.check()
        observed = self.stamp(base, name)
        if expected is UNSPECIFIED:
            expected = observed
        if observed != expected:
            fail("Metadata changed before publication: " + name)
        temp = ".write-" + uuid.uuid4().hex
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=base)
        saved, published = None, False
        try:
            self.write_fd(fd, data)
            os.fsync(fd)
            self.check()
            if expected is not None:
                saved = self.retire(base, name, expected)
            rename_exclusive(base, temp, base, name)
            published = True
            if self.stamp(base, name) != (digest(data), identity(os.fstat(fd))):
                fail("Metadata publication readback conflict: " + name)
            if saved is not None and self.stamp(base, saved) != expected:
                fail("Retained metadata preimage changed: " + saved)
            os.fsync(base)
            return os.fstat(fd)
        except BaseException:
            if saved is not None and not published:
                try:
                    rename_exclusive(base, saved, base, name)
                    os.fsync(base)
                except (OSError, SafetyError):
                    fail(f"Metadata publication conflict: {name}; verified preimage retained at {saved}; no destination was overwritten")
            raise
        finally:
            os.close(fd)
            # Failed private writes and verified preimages remain outside mods.

    @staticmethod
    def write_fd(fd, data):
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if not count:
                fail("Short file write")
            view = view[count:]

    def snapshot(self, base, exclude=()):
        files, directories, contents = {}, {}, {}

        def visit(fd, prefix):
            for name in sorted(os.listdir(fd)):
                if not prefix and name in exclude:
                    continue
                parts(name)
                path = prefix + name
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    with self.directory(fd, name) as child:
                        if identity(os.fstat(child)) != identity(info):
                            fail(f"Directory swap: {path}")
                        directories[path] = identity(info)
                        visit(child, path + "/")
                elif stat.S_ISREG(info.st_mode):
                    data, checked = self.read(fd, name)
                    files[path] = {"sha256": digest(data), "mode": stat.S_IMODE(checked.st_mode), "size": len(data), "inode": identity(checked)}
                    contents[path] = data
                else:
                    fail(f"Symlink or special file is protected: {path}")
        visit(base, "")
        return {"files": files, "directories": directories, "inode": identity(os.fstat(base))}, contents


class Operations:
    """One request per instance. Tests may override _clone at the transport boundary."""

    def __init__(self, app_home):
        self.fs = SafeFS(app_home)
        self.home = app_home
        self.mods = None
        self.shipped = set()
        self.data = None
        self.state = None
        self.registry = None
        self.registry_stamp = None
        self.initialized_stamp = None
        self.intent_stamp = None
        self.undo = []
        self.touched = set()
        self.live_dirs = {}
        self.live_files = {}
        self.preserved = []
        self.preserved_dirs = []
        self.intent = None
        self.stage_stamp = None
        self.stage_consumed = False
        self.retain_work = False
        self.work = None
        self.work_name = None
        self.lock = None
        self.discovery_lock = None

    def close(self):
        for fd in (self.work, self.lock, self.discovery_lock, self.mods, self.state, self.data):
            if fd is not None:
                os.close(fd)
        self.fs.close()

    def _check(self):
        self.fs.check()
        for fd, path in ((self.mods, "mods"), (self.data, "data"), (self.state, "data/mod-manager")):
            if fd is not None:
                with self.fs.directory(self.fs.root, path) as current:
                    if identity(os.fstat(fd)) != identity(os.fstat(current)):
                        fail(f"Unsafe directory swap: {path}")
        if self.work is not None:
            current = os.stat(self.work_name, dir_fd=self.state, follow_symlinks=False)
            if identity(current) != identity(os.fstat(self.work)):
                fail("Staging workspace swap detected")
        if self.lock is not None:
            current = os.stat("lock", dir_fd=self.state, follow_symlinks=False)
            if identity(current) != identity(os.fstat(self.lock)):
                fail("Lifecycle lock was replaced; no further writes are allowed")

    def _request(self, request):
        if not isinstance(request, dict):
            fail("Request must be a JSON object")
        allowed = {"action", "repository", "recipePath", "expectedCommit", "targetCommit", "stageToken", "modNames", "id", "path", "identityToken", "dependencies", "runtimeKnown", "migrationToken", "archivePath", "archiveGit"}
        if set(request) - allowed:
            fail("Unknown request fields: " + ", ".join(sorted(set(request) - allowed)))
        action = request.get("action")
        if action not in {"discover", "migrate", "install", "check-update", "prepare-update", "update", "uninstall"}:
            fail("Unknown action")
        if "migrationToken" in request and (not isinstance(request["migrationToken"], str) or not re.fullmatch(r"[0-9a-f]{64}", request["migrationToken"])):
            fail("Invalid migrationToken")
        if "archiveGit" in request and type(request["archiveGit"]) is not bool:
            fail("archiveGit must be a boolean")
        if "archivePath" in request and not isinstance(request["archivePath"], str):
            fail("archivePath must be a string")
        dependencies = request.get("dependencies", [])
        if not isinstance(dependencies, list) or any(not valid_id(value) for value in dependencies) or len(dependencies) > 10000:
            fail("dependencies must be a list of mod IDs")
        if "runtimeKnown" in request and not isinstance(request["runtimeKnown"], bool):
            fail("runtimeKnown must be a boolean")
        for field in ("expectedCommit", "targetCommit"):
            if field in request and (not isinstance(request[field], str) or not COMMIT.fullmatch(request[field])):
                fail(f"{field} must be a 40-character hexadecimal commit")
        if "stageToken" in request and (not isinstance(request["stageToken"], str) or not re.fullmatch(r"[0-9a-f]{32}", request["stageToken"])):
            fail("Invalid stageToken")
        if action in {"update", "prepare-update", "uninstall", "check-update"} and not valid_id(request.get("id")):
            fail("id must be a local mod folder name")
        if "path" in request and not isinstance(request["path"], str):
            fail("path must be a string")
        if "identityToken" in request and (not isinstance(request["identityToken"], str) or not re.fullmatch(r"[0-9a-f]{32}", request["identityToken"])):
            fail("Invalid identityToken")
        if "repository" in request:
            normalized_repository(request["repository"])
        if "recipePath" in request:
            parts(request["recipePath"], empty=True)
        if "modNames" in request:
            names = request["modNames"]
            if not isinstance(names, list) or not names or any(not valid_id(n) for n in names) or len(set(n.casefold() for n in names)) != len(names):
                fail("modNames must be a nonempty list of distinct mod folder names")
        return action

    def run(self, request):
        try:
            action = self._request(request)
            if action == "discover":
                return {"ok": True, **self._discover(request)}
            summary, self.migration_evidence = self._migration_summary()
            if action == "migrate":
                return self._migrate(request, summary)
            if summary["blocked"] or summary["required"]:
                fail(summary.get("reason", "Explicit migration is required before lifecycle changes"))
            if action != "install" and not self.fs.exists(self.fs.root, "data/mod-manager/registry.json"):
                fail("No v2 registry; only explicit install can initialize a fresh profile")
            with self.fs.directory(self.fs.root, "mods", create=action == "install") as fd:
                self.mods = os.dup(fd)
            with self.fs.directory(self.fs.root, "data", create=True) as fd:
                self.data = os.dup(fd)
            with self.fs.directory(self.data, "mod-manager", create=True) as fd:
                self.state = os.dup(fd)
            if os.fstat(self.mods).st_dev != os.fstat(self.state).st_dev:
                fail("Unsupported filesystem: staging and live mods must share a device")
            self._acquire_lock()
            self.registry, self.registry_stamp = self._read_registry(self.state, stamped=True)
            if self.registry["version"] != 2:
                fail("Registry version changed; explicit verified migration is required")
            self.initialized_stamp = self.fs.stamp(self.state, "initialized")
            if self.initialized_stamp is not None and self.fs.read(self.state, "initialized")[0] != b"1\n":
                fail("Corrupt initialized marker; restore verified manager metadata")
            if self.fs.exists(self.state, "transaction.json"):
                # Do not guess after a crash. The backup and complete intent remain.
                self.fs.read(self.state, "transaction.json")
                fail("Interrupted transaction blocks writes. Inspect data/mod-manager/transaction.json, registry.json and its workspace backups; restore or verify the recorded files before removing transaction.json. Do not retry or delete the registry to bypass recovery.")
            self._compare_registry()
            if action == "check-update":
                return self._check_update(request)
            if action == "prepare-update":
                return self._prepare_update(request)
            if action == "install":
                result = self._install(request)
            elif action == "update":
                result = self._update(request)
            else:
                result = self._uninstall(request)
            return {"ok": True, **self._discover(request), **result, "notice": NOTICE, "message": result.get("message", NOTICE)}
        except (SafetyError, OSError, subprocess.SubprocessError, UnicodeError, ValueError, TypeError, KeyError, OverflowError, RecursionError) as error:
            return {"ok": False, "error": str(error) or type(error).__name__}
        finally:
            self.close()

    def _migration_summary(self):
        """No mkdir, lock creation, metadata adoption, or Git writes during discovery."""
        targets, evidence = [], {"registry": None, "lock": None, "initialized": None, "migration": None}
        required, blocked, reason = False, False, None
        try:
            state = None
            try:
                state = self.fs.open_dir(self.fs.root, "data")
                child = self.fs.open_dir(state, "mod-manager")
                os.close(state)
                state = child
            except FileNotFoundError:
                if state is not None:
                    os.close(state)
                state = None
            except BaseException:
                if state is not None:
                    os.close(state)
                raise
            try:
                registry = {"version": 2, "mods": {}, "history": []}
                if state is not None:
                    if self.fs.exists(state, "migration.json"):
                        data, journal_info = self.fs.read(state, "migration.json")
                        journal = parse_json(data, "migration journal")
                        if not isinstance(journal, dict):
                            fail("Corrupt migration journal at data/mod-manager/migration.json")
                        self._verify_migration(state, journal, active=journal.get("phase") != "complete")
                        if journal["phase"] != "complete":
                            return {"required": True, "blocked": False, "token": journal["token"], "targets": journal["targets"], "reason": "Interrupted migration blocks lifecycle writes; explicit migrate resumes the verified journal at data/mod-manager/migration.json"}, {"journal": journal, "journalStamp": (digest(data), identity(journal_info))}
                        evidence["migration"] = self._metadata_preimage(state, "migration.json")
                    registry = self._read_registry(state)
                    evidence["registry"] = self._metadata_preimage(state, "registry.json")
                    if self.fs.exists(state, "transaction.json"):
                        fail("Interrupted transaction blocks writes; inspect data/mod-manager/transaction.json and its workspace backups")
                    if self.fs.exists(state, "lock"):
                        info = os.stat("lock", dir_fd=state, follow_symlinks=False)
                        if not stat.S_ISREG(info.st_mode):
                            fail("Unknown directory or linked lifecycle lock; cannot prove it stale. Inspect data/mod-manager/lock; it was not removed")
                        lock_data, lock_info = self.fs.read(state, "lock")
                        lock = parse_json(lock_data, "lock")
                        if lock not in ({"version": 1}, {"version": 2}) or type(lock.get("version")) is not int:
                            fail("Corrupt lifecycle lock; inspect data/mod-manager/lock")
                        if self.lock is None:
                            with close_fd(os.open("lock", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state)) as fd:
                                if identity(os.fstat(fd)) != identity(lock_info):
                                    fail("Lifecycle lock inode changed")
                                try:
                                    fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                                except BlockingIOError:
                                    fail("Another lifecycle operation is running; transaction changes are blocked")
                        evidence["lock"] = self._metadata_preimage(state, "lock")
                        required = lock["version"] == 1
                        if self.fs.exists(state, "registry.json") and registry["version"] != lock["version"]:
                            fail("Mixed lock/registry versions require verified migration journal recovery")
                    elif registry["version"] == 1 or self.fs.exists(state, "registry.json"):
                        fail("Missing persistent lifecycle lock; restore from a verified backup")
                    required = required or registry["version"] == 1
                records = {}
                if registry["version"] == 1:
                    for name, old in registry["mods"].items():
                        with self.fs.directory(self.fs.root, "mods/" + name) as fd:
                            self._clean(fd, old)
                        records[name] = {**old, "kind": "package"}
                main = {}
                if self.fs.exists(self.fs.root, "mods"):
                    with self.fs.directory(self.fs.root, "mods") as mods:
                        for name in sorted(os.listdir(mods)):
                            if name.startswith(".") or name in registry["mods"]:
                                continue
                            info = os.stat(name, dir_fd=mods, follow_symlinks=False)
                            if not stat.S_ISDIR(info.st_mode):
                                continue
                            with self.fs.directory(mods, name) as fd:
                                try:
                                    gitfd = self.fs.open_dir(fd, ".git")
                                except FileNotFoundError:
                                    continue
                                with close_fd(gitfd) as git:
                                    if not self.fs.exists(git, "herdr-mod-manager.json"):
                                        continue
                                    marker, _ = self.fs.read(git, "herdr-mod-manager.json")
                                main[name] = self._main_record(fd, name, marker)
                if main and registry["version"] == 2:
                    for name, record in registry["mods"].items():
                        with self.fs.directory(self.fs.root, "mods/" + name) as fd:
                            self._clean(fd, record)
                        records[name] = record
                records.update(main)
                folded, sources = set(), set()
                for name, record in records.items():
                    source = (record["repository"], record["recipePath"], record["modFolder"])
                    if name.casefold() in folded or source in sources:
                        fail("Conflicting mixed source or case-insensitive target identity; migration is blocked")
                    folded.add(name.casefold())
                    sources.add(source)
                required = required or bool(main)
                evidence.update(records=records, history=[{**r, "kind": "package"} for r in registry["history"]] if registry["version"] == 1 else registry["history"], initialized=self._metadata_preimage(state, "initialized") if state is not None else None)
                targets = [{"id": name, "path": r["path"], "repository": r["repository"], "kind": r["kind"]} for name, r in sorted(records.items())]
                if required:
                    reason = "Explicit migration is required; verified ownership and Git history will be retained"
            finally:
                if state is not None:
                    os.close(state)
        except (SafetyError, OSError, ValueError, TypeError, KeyError) as error:
            blocked, reason = True, str(error)
        token = digest(encode({"targets": targets, "evidence": evidence, "reason": reason}))
        result = {"required": required, "blocked": blocked, "token": token, "targets": targets}
        if reason:
            result["reason"] = reason
        return result, evidence

    def _metadata_preimage(self, fd, name):
        if fd is None or not self.fs.exists(fd, name):
            return None
        data, info = self.fs.read(fd, name)
        return {"data": data.hex(), "inode": identity(info), "mode": stat.S_IMODE(info.st_mode)}

    def _verify_migration(self, state, journal, active=True):
        required = {"version", "phase", "token", "targets", "workspace", "backup", "preimages", "lockInode", "registry"}
        if not isinstance(journal, dict) or set(journal) != required or type(journal["version"]) is not int or journal["version"] != 2 or journal["phase"] not in {"pending", "complete"} or not isinstance(journal["token"], str) or not re.fullmatch(r"[0-9a-f]{64}", journal["token"]):
            fail("Corrupt migration journal at data/mod-manager/migration.json")
        if not isinstance(journal["workspace"], str) or not re.fullmatch(r"migration-[0-9a-f]{32}", journal["workspace"]) or not isinstance(journal["registry"], dict) or set(journal["registry"]) != {"version", "mods", "history"} or journal["registry"]["version"] != 2 or not isinstance(journal["registry"]["mods"], dict) or not isinstance(journal["registry"]["history"], list) or not isinstance(journal["preimages"], dict) or set(journal["preimages"]) != {"lock", "registry.json", "initialized"}:
            fail("Corrupt migration identity at data/mod-manager/migration.json")
        for name, record in journal["registry"]["mods"].items():
            self._validate_record(name, record)
        for record in journal["registry"]["history"]:
            self._validate_record(record["id"], record)
        targets = [{"id": n, "path": r["path"], "repository": r["repository"], "kind": r["kind"]} for n, r in sorted(journal["registry"]["mods"].items())]
        if journal["targets"] != targets:
            fail("Corrupt migration target summary")
        with self.fs.directory(state, journal["workspace"]) as backup:
            manifest, manifest_info = self.fs.read(backup, "intent.json")
            expected_receipt = {"version": 2, "token": journal["token"], "workspaceInode": identity(os.fstat(backup)), "manifestSha256": digest(manifest), "manifestInode": identity(manifest_info)}
            receipt, _ = self.fs.read(state, self._migration_receipt_path(journal))
            if parse_json(receipt, "migration receipt") != expected_receipt or manifest != encode({k: v for k, v in journal.items() if k != "phase"}):
                fail("Migration manifest/receipt provenance changed; retain all preimages")
            if journal["phase"] == "complete":
                completed, _ = self.fs.read(state, self._migration_receipt_path(journal, complete=True))
                if parse_json(completed, "migration completion receipt") != expected_receipt:
                    fail("Migration completion was not verified; phase changes cannot bypass recovery")
            snapshot, contents = self.fs.snapshot(backup, exclude={"intent.json"})
            if snapshot != journal["backup"]:
                fail("Migration preimages changed; retain data/mod-manager/migration.json and backups")
            for name, image in journal["preimages"].items():
                if image is not None and (not isinstance(image, dict) or set(image) != {"data", "inode", "mode"} or bytes.fromhex(image["data"]) != contents.get(name)):
                    fail("Migration preimages do not match the retained backups")
        if not active:
            return
        for name, record in journal["registry"]["mods"].items():
            with self.fs.directory(self.fs.root, "mods/" + name) as fd:
                self._clean(fd, record)
        for name in ("lock", "registry.json", "initialized"):
            current = self._metadata_preimage(state, name)
            old = journal["preimages"][name]
            if name == "lock":
                if current is None or current["inode"] != journal["lockInode"] or bytes.fromhex(current["data"]) not in (encode({"version": 1}), encode({"version": 2}), bytes.fromhex(old["data"]) if old else b""):
                    fail("Migration lock changed; same-inode verified handover is required")
            elif current != old:
                expected = encode(journal["registry"]) if name == "registry.json" else b"1\n"
                if current is None or bytes.fromhex(current["data"]) != expected:
                    fail("Migration metadata conflicts with journal; retain all recovery data")

    def _migration_metadata_stamp(self, journal, name):
        current = self._metadata_preimage(self.state, name)
        old = journal["preimages"][name]
        target = encode(journal["registry"]) if name == "registry.json" else b"1\n"
        if current != old and (current is None or bytes.fromhex(current["data"]) != target):
            fail("Migration metadata conflicts with its pinned source preimage")
        return (digest(bytes.fromhex(current["data"])), current["inode"]) if current else None

    def _migration_receipt_path(self, journal, complete=False):
        return ("migration-complete-" if complete else "migration-receipt-") + journal["workspace"].removeprefix("migration-") + ".json"

    def _migration_point(self, point):
        """Fault-injection boundary. No production behavior."""

    def _migrate(self, request, summary):
        if request.get("migrationToken") != summary["token"]:
            fail("Stale migrationToken; discover and confirm the current read-only target summary")
        if summary["blocked"]:
            fail(summary.get("reason", "Migration is blocked"))
        if not summary["required"]:
            return {"ok": True, **self._discover(request), "message": "No migration is required"}
        with self.fs.directory(self.fs.root, "mods") as fd:
            self.mods = os.dup(fd)
        with self.fs.directory(self.fs.root, "data", create=True) as fd:
            self.data = os.dup(fd)
        with self.fs.directory(self.data, "mod-manager", create=True) as fd:
            self.state = os.dup(fd)
        self._acquire_lock(migration=True)
        # Verify sources AGAIN while holding the exclusive legacy flock.
        current, evidence = self._migration_summary()
        if "journal" in evidence:
            journal = evidence["journal"]
            journal_stamp = evidence["journalStamp"]
            self._verify_migration(self.state, journal)
        else:
            # A main-only profile gains a v2 lock above. Remove that new lock
            # from the summary comparison, not from the filesystem.
            old_summary, old_evidence = summary, self.migration_evidence
            if current["blocked"] or current["targets"] != old_summary["targets"]:
                fail(current.get("reason", "Migration source changed"))
            # Source token can differ only for a newly created v2 lock.
            if {k: v for k, v in evidence.items() if k != "lock"} != {k: v for k, v in old_evidence.items() if k != "lock"} or (old_evidence.get("lock") is not None and evidence.get("lock") != old_evidence["lock"]):
                fail("Migration source changed after confirmation")
            records = evidence["records"]
            registry = {"version": 2, "mods": records, "history": evidence["history"]}
            self.work_name = "migration-" + uuid.uuid4().hex
            os.mkdir(self.work_name, 0o700, dir_fd=self.state)
            self.work = self.fs.open_dir(self.state, self.work_name)
            preimages = {name: self._metadata_preimage(self.state, name) for name in ("lock", "registry.json", "initialized")}
            for name, image in preimages.items():
                if image is not None:
                    self._store(self.work, name, bytes.fromhex(image["data"]), 0o600)
            if evidence.get("migration") is not None:
                self._store(self.work, "previous-migration.json", bytes.fromhex(evidence["migration"]["data"]), 0o600)
            backup, _ = self.fs.snapshot(self.work)
            os.fsync(self.work)
            os.fsync(self.state)
            journal = {"version": 2, "phase": "pending", "token": summary["token"], "targets": summary["targets"], "workspace": self.work_name, "backup": backup, "preimages": preimages, "lockInode": identity(os.fstat(self.lock)), "registry": registry}
            manifest = encode({k: v for k, v in journal.items() if k != "phase"})
            manifest_info = self.fs.atomic(self.work, "intent.json", manifest, expected=None)
            receipt = {"version": 2, "token": journal["token"], "workspaceInode": identity(os.fstat(self.work)), "manifestSha256": digest(manifest), "manifestInode": identity(manifest_info)}
            self._store(self.state, self._migration_receipt_path(journal), encode(receipt), 0o600)
            self._migration_point("manifest")
            previous = evidence.get("migration")
            previous_stamp = (digest(bytes.fromhex(previous["data"])), previous["inode"]) if previous else None
            encoded_journal = encode(journal)
            published = self.fs.atomic(self.state, "migration.json", encoded_journal, expected=previous_stamp)
            journal_stamp = (digest(encoded_journal), identity(published))
        self._migration_point("intent")
        self._verify_migration(self.state, journal)
        self._check()
        # Upgrade bytes in the acquired inode. Never unlink or replace a lock.
        os.lseek(self.lock, 0, os.SEEK_SET)
        self.fs.write_fd(self.lock, encode({"version": 2}))
        os.ftruncate(self.lock, len(encode({"version": 2})))
        os.fsync(self.lock)
        self._migration_point("lock")
        self._verify_migration(self.state, journal)
        self.fs.atomic(self.state, "registry.json", encode(journal["registry"]), expected=self._migration_metadata_stamp(journal, "registry.json"))
        self._migration_point("registry")
        self.fs.atomic(self.state, "initialized", b"1\n", expected=self._migration_metadata_stamp(journal, "initialized"))
        self._migration_point("initialized")
        self._verify_migration(self.state, journal)
        receipt, _ = self.fs.read(self.state, self._migration_receipt_path(journal))
        completed = self._migration_receipt_path(journal, complete=True)
        if self.fs.exists(self.state, completed):
            if self.fs.read(self.state, completed)[0] != receipt:
                fail("Migration completion receipt changed; retain all recovery data")
        else:
            self._store(self.state, completed, receipt, 0o600)
        self._migration_point("completion-receipt")
        journal["phase"] = "complete"
        self.fs.atomic(self.state, "migration.json", encode(journal), expected=journal_stamp)
        self._migration_point("complete")
        return {"ok": True, **self._discover(request), "message": "Migration verified; legacy metadata preimages and Git history were retained", "notice": NOTICE}

    def _main_record(self, fd, name, marker):
        metadata = parse_json(marker, "legacy ownership marker")
        if not isinstance(metadata, dict) or set(metadata) != {"version", "url", "branch"} or type(metadata["version"]) is not int or metadata["version"] != 1:
            fail("Invalid legacy checkout ownership metadata")
        url = metadata["url"]
        match = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)\.git", url) if isinstance(url, str) else None
        repository = normalized_repository(match[1]) if match else fail("Legacy checkout needs its recorded public HTTPS origin")
        if name != repository.split("/")[1] or url != "https://github.com/" + repository + ".git":
            fail("Legacy checkout path/source identity changed")
        snapshot, contents, git_snapshot, commit = self._inspect_git(fd, metadata["branch"], url)
        self._validate_package({p: (data, snapshot["files"][p]["mode"]) for p, data in contents.items()})
        record = self._record(name, repository, "", "", commit, snapshot)
        record.update(kind="git", branch=metadata["branch"], git=git_snapshot)
        record["identityToken"] = digest(encode(record | {"identityToken": ""}))[:32]
        return record

    def _inspect_git(self, fd, branch, url):
        if not isinstance(branch, str) or not branch or branch.startswith("-"):
            fail("Invalid recorded Git branch")
        with close_fd(self.fs.open_dir(fd, ".git")) as git:
            git_snapshot, _ = self.fs.snapshot(git)
        if any(p.endswith(".lock") for p in (*git_snapshot["files"], *git_snapshot["directories"])):
            fail("Occupied Git metadata lock; no live files were changed")
        if any(p in git_snapshot["files"] for p in ("objects/info/alternates", "objects/info/http-alternates", "commondir", "gitdir", "shallow", "info/grafts")) or any(p.startswith("refs/replace/") for p in git_snapshot["files"]):
            fail("Linked or redirected Git metadata is unsupported")
        config = self._git(["config", "--local", "--no-includes", "--list"], fd).decode()
        allowed = re.compile(r"(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(?:url|fetch)|branch\.[^\n]+\.(?:remote|merge))\Z", re.I)
        if any("=" not in line or not allowed.fullmatch(line.split("=", 1)[0]) for line in config.splitlines()):
            fail("Unsupported local Git configuration; includes, hooks, filters and redirects are forbidden")
        if self._git(["config", "--local", "--no-includes", "--get", "core.bare"], fd).strip() != b"false":
            fail("Bare checkout is unsupported")
        self._git(["check-ref-format", "refs/heads/" + branch], fd)
        if self._git(["symbolic-ref", "HEAD"], fd).decode().strip() != "refs/heads/" + branch:
            fail("Checkout branch changed from recorded ownership")
        if self._git(["config", "--local", "--no-includes", "--get", "remote.origin.url"], fd).decode().strip() != url:
            fail("Checkout origin changed from recorded ownership")
        if any(line and not line.startswith(b"H ") for line in self._git(["ls-files", "-vz"], fd).split(b"\0")):
            fail("Hidden or staged Git index flags are protected")
        if self._git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], fd).strip():
            fail("Dirty checkout: local, staged, untracked or ignored files are protected")
        commit, tree = self._tree(fd)
        snapshot, contents = self.fs.snapshot(fd, exclude={".git"})
        if set(contents) != set(tree):
            fail("Checkout files differ from the full recorded Git root tree")
        for path, (blob, mode) in tree.items():
            if contents[path] != self._git(["cat-file", "blob", blob], fd) or snapshot["files"][path]["mode"] != mode:
                fail("Checkout baseline differs from Git HEAD: " + path)
        dirs = {"/".join(parts(p)[:n]) for p in tree for n in range(1, len(parts(p)))}
        if set(snapshot["directories"]) != dirs:
            fail("Untracked checkout directories are protected")
        with close_fd(self.fs.open_dir(fd, ".git")) as git:
            if self.fs.snapshot(git)[0] != git_snapshot:
                fail("Git metadata changed during verification")
        return snapshot, contents, git_snapshot, commit

    def _clean_git(self, fd, record):
        snapshot, contents, metadata, commit = self._inspect_git(fd, record["branch"], "https://github.com/" + record["repository"] + ".git")
        expected = {key: record[key] for key in ("files", "directories", "inode")}
        # Git status may safely refresh only the index stat cache/inode. The
        # full tree, stage, hidden flags and clean status were verified above.
        # Do not write this observation into the persistent ownership record.
        before_git = {**record["git"], "files": {p: v for p, v in record["git"]["files"].items() if p != "index"}}
        current_git = {**metadata, "files": {p: v for p, v in metadata["files"].items() if p != "index"}}
        if snapshot != expected or current_git != before_git or commit != record["commit"]:
            fail("Local changes or Git metadata identity conflict")
        self.verified_git_metadata = metadata
        return snapshot, contents

    def _archive_path(self, record):
        return self.home + "/data/mod-manager/archive-" + record["id"] + "-" + record["identityToken"]

    def _acquire_lock(self, migration=False):
        created = False
        try:
            self.lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.state)
            created = True
        except FileExistsError:
            self.lock = os.open("lock", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.state)
        info = os.fstat(self.lock)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail("Unsafe lifecycle lock")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("Another lifecycle operation is running; retry after it finishes")
        if not created:
            data, current = self.fs.read(self.state, "lock")
            value = parse_json(data, "lock")
            if not isinstance(value, dict) or value not in ([{"version": 1}, {"version": 2}] if migration else [{"version": 2}]) or type(value.get("version")) is not int or identity(current) != identity(info):
                fail("Corrupt lifecycle lock; inspect data/mod-manager/lock before recovery")
        else:
            self.fs.write_fd(self.lock, encode({"version": 2}))
            os.fsync(self.lock)
        self._check()

    def _read_registry(self, state, stamped=False):
        if not self.fs.exists(state, "registry.json"):
            if self.fs.exists(state, "transaction.json"):
                fail("Missing registry with an interrupted transaction; recover transaction.json before writes")
            # A marker prevents a deleted registry from silently resetting ownership.
            if self.fs.exists(state, "initialized"):
                fail("Missing registry in initialized store; restore registry.json from a verified backup")
            empty = {"version": 2, "mods": {}, "history": []}
            return (empty, None) if stamped else empty
        data, info = self.fs.read(state, "registry.json")
        value = parse_json(data, "registry.json")
        if not isinstance(value, dict) or set(value) != {"version", "mods", "history"} or type(value["version"]) is not int or value["version"] not in {1, 2} or not isinstance(value["mods"], dict) or not isinstance(value["history"], list):
            fail("Corrupt registry; restore data/mod-manager/registry.json from a verified backup")
        for name, record in value["mods"].items():
            self._validate_record(name, record, legacy=value["version"] == 1)
        for record in value["history"]:
            if not isinstance(record, dict) or not valid_id(record.get("id")):
                fail("Corrupt registry history")
            self._validate_record(record["id"], record, legacy=value["version"] == 1)
        return (value, (digest(data), identity(info))) if stamped else value

    def _validate_record(self, name, record, legacy=False):
        if not valid_id(name) or not isinstance(record, dict):
            fail("Corrupt registry record")
        required = {"id", "repository", "recipePath", "modFolder", "path", "commit", "files", "directories", "inode", "identityToken"}
        if not legacy:
            required.add("kind")
            if record.get("kind") == "git":
                required.update({"branch", "git"})
            elif record.get("kind") != "package":
                fail("Corrupt registry record kind")
        if set(record) != required or record["id"] != name or record["path"] != self.home + "/mods/" + name or normalized_repository(record["repository"]) != record["repository"]:
            fail(f"Corrupt registry identity: {name}")
        parts(record["recipePath"], empty=True)
        parts(record["modFolder"], empty=True)
        if not isinstance(record["commit"], str) or not COMMIT.fullmatch(record["commit"]) or not isinstance(record["identityToken"], str) or not re.fullmatch(r"[0-9a-f]{32}", record["identityToken"]):
            fail(f"Corrupt registry revision: {name}")
        if not isinstance(record["files"], dict) or not {"mod.json", "main.js"} <= set(record["files"]) or not isinstance(record["directories"], dict):
            fail(f"Corrupt registry baseline: {name}")
        for inode in [record["inode"], *record["directories"].values()]:
            if not isinstance(inode, list) or len(inode) != 2 or any(type(n) is not int or n < 0 for n in inode):
                fail(f"Corrupt registry inode: {name}")
        for path in record["directories"]:
            parts(path)
        for path, entry in record["files"].items():
            parts(path)
            if not isinstance(entry, dict) or set(entry) != {"sha256", "mode", "size", "inode"} or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) or type(entry["size"]) is not int or not 0 <= entry["size"] <= LIMIT or type(entry["mode"]) is not int or entry["mode"] not in {0o644, 0o755} or not isinstance(entry["inode"], list) or len(entry["inode"]) != 2 or any(type(n) is not int or n < 0 for n in entry["inode"]):
                fail(f"Corrupt registry file baseline: {name}/{path}")

        if not legacy and record["kind"] == "git":
            metadata = record["git"]
            if not isinstance(record["branch"], str) or not record["branch"] or not isinstance(metadata, dict) or set(metadata) != {"files", "directories", "inode"} or not isinstance(metadata["files"], dict) or not isinstance(metadata["directories"], dict) or not {"HEAD", "config", "index", "herdr-mod-manager.json"} <= metadata["files"].keys():
                fail("Corrupt Git ownership baseline")
            for inode in [metadata["inode"], *metadata["directories"].values()]:
                if not isinstance(inode, list) or len(inode) != 2 or any(type(n) is not int or n < 0 for n in inode):
                    fail("Corrupt Git metadata inode")
            for path in metadata["directories"]:
                parts(path)
            for path, entry in metadata["files"].items():
                parts(path)
                if not isinstance(entry, dict) or set(entry) != {"sha256", "mode", "size", "inode"} or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) or type(entry["size"]) is not int or not 0 <= entry["size"] <= LIMIT or type(entry["mode"]) is not int or entry["mode"] not in {0o444, 0o600, 0o644, 0o755} or not isinstance(entry["inode"], list) or len(entry["inode"]) != 2 or any(type(n) is not int or n < 0 for n in entry["inode"]):
                    fail("Corrupt Git metadata file baseline")

    def _compare_registry(self):
        self._check()
        if self.fs.exists(self.state, "registry.json"):
            data, info = self.fs.read(self.state, "registry.json")
            if self.registry_stamp != (digest(data), identity(info)):
                fail("Registry changed during operation; recover the recorded transaction")
        elif self.registry_stamp is not None:
            fail("Registry disappeared during operation; recover the recorded transaction")

    def _save_registry(self):
        self._compare_registry()
        # Recheck the exact verified baseline, not a new ownership snapshot.
        for name in self.touched & self.registry["mods"].keys():
            with self.fs.directory(self.mods, name) as fd:
                self._clean(fd, self.registry["mods"][name])
        data = encode(self.registry)
        info = self.fs.atomic(self.state, "registry.json", data, expected=self.registry_stamp)
        self.registry_stamp = (digest(data), identity(info))
        initialized = self.fs.atomic(self.state, "initialized", b"1\n", expected=self.initialized_stamp)
        self.initialized_stamp = (digest(b"1\n"), identity(initialized))

    def _protection(self, request):
        protected = {"mod-manager": "The running manager is protected"}
        self.shipped = set()
        unknown = []
        for name in request.get("dependencies", []):
            protected[name] = "Active runtime dependency"
        known_mods = set(request.get("modNames", [])) | set(request.get("dependencies", []))
        try:
            with self.fs.directory(self.fs.root, "mods") as mods:
                known_mods.update(name for name in os.listdir(mods) if valid_id(name))
        except FileNotFoundError:
            pass

        def command_reference(command, args, reason):
            if not isinstance(command, str):
                fail("Unknown command metadata")
            if command.startswith("mod.open:"):
                target = command[len("mod.open:"):]
                if not valid_id(target):
                    fail("Unknown mod.open string command arguments")
                protected.setdefault(target, reason)
            elif command in {"mod.open", "mod.close", "mod.toggle", "mod.focus", "mod.show", "mod.hide", "mod.clone"}:
                target = args.get("name", args.get("id", args.get("mod"))) if isinstance(args, dict) else None
                if not valid_id(target):
                    fail("Unknown mod command arguments")
                protected.setdefault(target, reason)
            elif command.startswith("mod."):
                fail("Unknown mod command: " + command)
            else:
                builtin = {"space", "tab", "pane", "terminal", "agent", "layout", "overlay", "app", "herdr", "window", "text", "editor"}
                if ":" in command:
                    target, _, action = command.partition(":")
                    if valid_id(target) and action and target not in builtin:
                        protected.setdefault(target, reason)
                elif "." in command and command.partition(".")[0] not in builtin:
                    candidates = [name for name in known_mods if command.startswith(name + ".")]
                    target = max(candidates, key=len) if candidates else command.partition(".")[0]
                    if valid_id(target):
                        protected.setdefault(target, reason)

        def collect(value, reason, bindings=False):
            # Parse mod references, not arbitrary theme text, titles or JSON keys.
            if isinstance(value, dict):
                for key in ("mod", "modId", "modName", "mod_id", "mod_name", "terminal_menu", "toast_mod"):
                    if key in value:
                        if not valid_id(value[key]):
                            fail("Invalid mod-reference field: " + key)
                        protected.setdefault(value[key], reason)
                if "command" in value:
                    command_reference(value["command"], value.get("args", {}), reason)
                # Layout leaf nodes use kind:'mod' plus id/name.
                if value.get("kind") == "mod" or value.get("type") == "mod":
                    target = value.get("id", value.get("name"))
                    if not valid_id(target):
                        fail("Unknown layout mod node")
                    protected.setdefault(target, reason)
                for key, child in value.items():
                    if key not in {"command", "description", "title", "label", "theme", "look", "style", "props"}:
                        collect(child, reason, bindings=bindings or key in {"keys", "keybindings", "bindings"})
            elif isinstance(value, list):
                for child in value:
                    collect(child, reason, bindings=bindings)
            elif isinstance(value, str) and bindings:
                command_reference(value, {}, reason)

        def read_metadata(fd, name, reason):
            try:
                data, _ = self.fs.read(fd, name)
                value = parse_json(data, name)
                if not isinstance(value, (dict, list)):
                    fail("metadata must be an object or array")
                collect(value, reason, bindings=name in {"keys.json", "keybindings.json"})
                if name == "installed.json":
                    if not isinstance(value, dict):
                        fail("installed.json must map shipped names to file fingerprints")
                    for shipped_name in value:
                        if valid_id(shipped_name):
                            self.shipped.add(shipped_name)
                            protected[shipped_name] = "Shipped mod (installed.json)"
            except (SafetyError, OSError, ValueError) as error:
                unknown.append(f"Cannot establish dependency safety from {name}: {error}")

        if not self.fs.exists(self.fs.root, "installed.json"):
            unknown.append("Missing installed.json; shipped-mod protection cannot be established")
        for name in os.listdir(self.fs.root):
            if name == "installed.json":
                read_metadata(self.fs.root, name, "Host bookkeeping reference (installed.json)")
            elif name.endswith(".json") and name != "seen.json":
                read_metadata(self.fs.root, name, "Configured layout or key dependency")
            elif name in {"layouts", "keys", "keybindings"}:
                try:
                    with self.fs.directory(self.fs.root, name) as fd:
                        def scan(parent):
                            for child in os.listdir(parent):
                                info = os.stat(child, dir_fd=parent, follow_symlinks=False)
                                if stat.S_ISDIR(info.st_mode):
                                    with self.fs.directory(parent, child) as nested:
                                        scan(nested)
                                elif child.endswith(".json"):
                                    read_metadata(parent, child, "Configured layout or key dependency")
                                elif not stat.S_ISREG(info.st_mode):
                                    fail(f"Unsafe metadata entry: {child}")
                        scan(fd)
                except (SafetyError, OSError) as error:
                    unknown.append(f"Cannot inspect {name}: {error}")
        return protected, unknown

    def _discover(self, request):
        migration, _ = self._migration_summary()
        warnings = [migration["reason"]] if migration.get("reason") else []
        records = {}
        interrupted = False
        try:
            with self.fs.directory(self.fs.root, "data/mod-manager") as state:
                records = self._read_registry(state)["mods"]
                interrupted = self.fs.exists(state, "transaction.json")
                if interrupted:
                    warnings.append("Interrupted transaction: lifecycle changes are blocked; inspect data/mod-manager/transaction.json and backups")
                if self.fs.exists(state, "lock"):
                    lock, _ = self.fs.read(state, "lock")
                    lock_value = parse_json(lock, "lock")
                    if lock_value not in ({"version": 1}, {"version": 2}) or type(lock_value.get("version")) is not int:
                        fail("Corrupt lifecycle lock")
                    if self.lock is None:
                        self.discovery_lock = os.open("lock", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state)
                        try:
                            fcntl.flock(self.discovery_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                        except BlockingIOError:
                            interrupted = True
                            warnings.append("A lifecycle operation is in progress; this inventory can be incomplete and changes are blocked")
        except FileNotFoundError:
            pass
        except (SafetyError, OSError, ValueError) as error:
            warnings.append(str(error))
            records = {}
        protected, unknown = self._protection(request)
        warnings.extend(unknown)
        mods = []
        try:
            with self.fs.directory(self.fs.root, "mods") as mods_fd:
                for name in sorted(os.listdir(mods_fd)):
                    if name.startswith("."):
                        continue
                    path = self.home + "/mods/" + name
                    entry = {"id": name, "modName": name, "name": name, "description": "", "version": "", "repository": "", "recipePath": "", "source": "local", "managed": False, "path": path}
                    info = os.stat(name, dir_fd=mods_fd, follow_symlinks=False)
                    reason = protected.get(name)
                    if name in self.shipped:
                        entry["source"] = "shipped"
                    if stat.S_ISLNK(info.st_mode):
                        entry["source"] = "development"
                        reason = "Symbolic-link mod is protected; its target was not read"
                    elif not stat.S_ISDIR(info.st_mode):
                        reason = "Mod target is not a real directory"
                    else:
                        try:
                            with self.fs.directory(mods_fd, name) as fd:
                                record = records.get(name)
                                if record and identity(os.fstat(fd)) == record["inode"]:
                                    entry.update(repository=record["repository"], recipePath=record["recipePath"], commit=record["commit"], identityToken=record["identityToken"], source="shipped" if name in self.shipped else "github", managed=True)
                                elif record:
                                    reason = reason or "Target directory identity changed; ownership is not verified"
                                manifest, _ = self.fs.read(fd, "mod.json")
                                manifest = parse_json(manifest, name + "/mod.json")
                                if not isinstance(manifest, dict):
                                    fail("mod.json must be an object")
                                for key, field in (("name", "title"), ("description", "description"), ("version", "version")):
                                    value = manifest.get(field, manifest.get("name", name) if key == "name" else "")
                                    if not isinstance(value, str):
                                        fail(f"Manifest {field} must be a string")
                                    entry[key] = value
                                self.fs.read(fd, "main.js")
                                if record and entry["managed"]:
                                    try:
                                        self._clean(fd, record)
                                    except (SafetyError, OSError) as error:
                                        reason = reason or str(error)
                        except (SafetyError, OSError, ValueError) as error:
                            reason = f"Broken or unreadable mod metadata: {error}"
                    if not entry["managed"]:
                        reason = reason or "Ownership is not verified; only manager-owned mods can be changed"
                    if interrupted:
                        reason = reason or "Interrupted lifecycle transaction requires recovery"
                    if migration["required"] or migration["blocked"]:
                        reason = reason or migration.get("reason", "Explicit migration is required")
                    if records.get(name, {}).get("kind") == "git":
                        entry["kind"] = "git"
                        entry["archivePath"] = self._archive_path(records[name])
                    if unknown:
                        reason = reason or unknown[0]
                    if request.get("runtimeKnown") is not True:
                        reason = reason or "Runtime dependencies are unknown; update and uninstall are blocked"
                    if reason:
                        entry["protectedReason"] = reason
                    mods.append(entry)
        except FileNotFoundError:
            pass
        for name in records.keys() - {entry["id"] for entry in mods}:
            warnings.append(f"Registry target is missing: {name}; ownership must be recovered before reinstall")
        return {"mods": mods, "warnings": warnings, "migration": migration}

    def _clean(self, fd, record):
        if record.get("kind") == "git":
            return self._clean_git(fd, record)
        current, contents = self.fs.snapshot(fd)
        if current["inode"] != record["inode"]:
            fail("Target directory identity changed; ownership is not verified")
        expected = record["files"]
        for name, baseline in expected.items():
            if current["files"].get(name) != baseline:
                fail(f"Local changes or file identity conflict: {name}")
        for name in current["files"].keys() - expected.keys():
            fail(f"Untracked local file: {name}; generated-looking names do not establish ownership")
        if current["directories"] != record["directories"]:
            fail("Local directory changes or identity conflict")
        return current, contents

    def _eligible(self, request, destructive=True):
        name = request["id"]
        record = self.registry["mods"].get(name)
        if not record:
            fail("Ownership is unknown; target is not manager-owned")
        if destructive:
            if request.get("runtimeKnown") is not True:
                fail("Runtime dependencies are unknown; runtimeKnown must be true before update or uninstall")
            protected, unknown = self._protection(request)
            if name in protected:
                fail(protected[name])
            if unknown:
                fail(unknown[0])
        if "repository" in request and normalized_repository(request["repository"]) != record["repository"]:
            fail("Repository source mismatch")
        if "recipePath" in request and request["recipePath"] != record["recipePath"]:
            fail("Recipe source mismatch")
        if "expectedCommit" in request and request["expectedCommit"].lower() != record["commit"]:
            fail("Stale confirmation: installed commit changed")
        if "path" in request and request["path"] != record["path"]:
            fail("Stale confirmation: target path changed")
        if "identityToken" in request and request["identityToken"] != record["identityToken"]:
            fail("Stale confirmation: ownership identity changed")
        self._compare_registry()
        with self.fs.directory(self.mods, name) as fd:
            self._clean(fd, record)
        self.live_dirs[name] = dict(record["directories"])
        self.live_files[name] = dict(record["files"])
        return record

    def _git(self, arguments, cwd_fd, input_data=None, extra_env=None):
        executable = shutil.which("git")
        if not executable:
            fail("git is unavailable; install a trusted local git separately. No tool was downloaded")
        env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": "/nonexistent", "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/usr/bin/false", "GIT_ALLOW_PROTOCOL": "https", "GIT_LFS_SKIP_SMUDGE": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_REPLACE_OBJECTS": "1"}
        if extra_env:
            env.update(extra_env)
        command = [executable, "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "core.fsync=committed", *arguments]
        result = subprocess.run(command, preexec_fn=lambda: os.fchdir(cwd_fd), pass_fds=(cwd_fd,), env=env, input=input_data, stdin=subprocess.DEVNULL if input_data is None else None, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
        if result.returncode:
            fail("git failed: " + result.stderr.decode("utf-8", "replace")[-2000:].strip())
        return result.stdout

    def _clone(self, repository, workspace_fd):
        # The production transport has no local/file/SSH/private-repository mode.
        repository = normalized_repository(repository)
        self._git(["clone", "--no-checkout", "--no-hardlinks", "--template=", "--", f"https://github.com/{repository}.git", "repository"], workspace_fd)

    def _workspace(self):
        self._check()
        self.work_name = "work-" + uuid.uuid4().hex
        os.mkdir(self.work_name, 0o700, dir_fd=self.state)
        self.work = self.fs.open_dir(self.state, self.work_name)

    def _fetch(self, repository):
        self._workspace()
        self._clone(repository, self.work)
        self._check()
        return self.fs.open_dir(self.work, "repository")

    def _tree(self, repo, revision="HEAD"):
        commit = self._git(["rev-parse", "--verify", revision + "^{commit}"], repo).decode().strip()
        if not COMMIT.fullmatch(commit):
            fail("Repository HEAD is not a SHA-1 commit")
        tree = {}
        total = 0
        for raw in self._git(["ls-tree", "-r", "-z", "--full-tree", commit], repo).split(b"\0"):
            if not raw:
                continue
            header, raw_path = raw.split(b"\t", 1)
            mode, kind, blob = header.decode("ascii").split(" ")
            path = raw_path.decode("utf-8")
            parts(path)
            if mode not in {"100644", "100755"} or kind != "blob":
                fail(f"Unsupported repository tree mode {mode}: {path}; symlinks and gitlinks are forbidden")
            if len(tree) >= 10000:
                fail("Repository contains too many files")
            size = int(self._git(["cat-file", "-s", blob], repo))
            total += size
            if size > LIMIT or total > 128 * 1024 * 1024:
                fail("Repository content exceeds the safe staging limit")
            tree[path] = (blob, int(mode[-3:], 8))
        return commit.lower(), tree

    def _packages(self, repo, tree, recipe, selection):
        prefix = recipe + "/" if recipe else ""
        root = prefix + "mod.json" in tree
        bundle_prefix = prefix + "mods/"
        candidates = sorted({path[len(bundle_prefix):].split("/")[0] for path in tree if path.startswith(bundle_prefix) and path.count("/") == bundle_prefix.count("/") + 1 and path.endswith("/mod.json")})
        if root and candidates:
            fail("Ambiguous repository: both a root mod and a recipe bundle exist; select a distinct recipePath")
        if root:
            manifest = self._git(["cat-file", "blob", tree[prefix + "mod.json"][0]], repo)
            value = parse_json(manifest, prefix + "mod.json")
            # Folder identity is never derived from a display title.
            name = selection[0] if selection and len(selection) == 1 else None
            if selection and len(selection) != 1:
                fail("A root mod requires exactly one modNames entry")
            if name is None:
                if isinstance(value, dict) and valid_id(value.get("id")):
                    name = value["id"]
                else:
                    fail("Root mod needs an explicit modNames:[folder] selection (or a valid manifest id)")
            chosen = [(name, prefix)]
        elif candidates:
            if selection is None:
                fail("Recipe bundle requires explicit modNames selection: " + ", ".join(candidates))
            if any(name not in candidates for name in selection):
                fail("Selected modNames do not match the case-sensitive recipe bundle")
            chosen = [(name, bundle_prefix + name + "/") for name in selection]
        else:
            fail("No mod.json at recipePath and no mods/<name>/ bundle; specify the exact case-sensitive recipePath")
        packages = []
        for name, folder in chosen:
            if not valid_id(name):
                fail("Invalid target mod folder")
            files = {}
            folded = set()
            for path, (blob, mode) in tree.items():
                if not path.startswith(folder):
                    continue
                relative = path[len(folder):]
                parts(relative)
                if relative.casefold() in folded:
                    fail("Case-conflicting package files")
                folded.add(relative.casefold())
                data = self._git(["cat-file", "blob", blob], repo)
                files[relative] = (data, mode)
            self._validate_package(files)
            packages.append((name, folder.rstrip("/"), files))
        return packages

    def _validate_package(self, files):
        if not {"mod.json", "main.js"} <= set(files):
            fail("A mod must contain mod.json and a nonempty main.js")
        manifest = parse_json(files["mod.json"][0], "downloaded mod.json")
        if not isinstance(manifest, dict):
            fail("Downloaded mod.json must be an object")
        if "place" in manifest and manifest["place"] not in ("none", "left", "right", "top", "bottom"):
            fail("Unsupported manifest placement")
        if "title" in manifest and (not isinstance(manifest["title"], str) or not manifest["title"].strip()):
            fail("Manifest title must be a nonempty string")
        def positive(value):
            return type(value) in {int, float} and math.isfinite(value) and value > 0
        if "size" in manifest and not positive(manifest["size"]):
            fail("Manifest size must be a positive number")
        if "overlay" in manifest:
            overlay = manifest["overlay"]
            if not isinstance(overlay, dict) or ("kind" in overlay and overlay["kind"] not in ("dialog", "popup", "window")):
                fail("Invalid manifest overlay kind")
            for dimension in ("width", "height"):
                if dimension in overlay and not positive(overlay[dimension]):
                    fail("Manifest overlay " + dimension + " must be a positive number")
        if any(key.casefold() in {"scripts", "hooks", "preinstall", "postinstall", "install"} for key in manifest):
            fail("Dangerous lifecycle fields in mod.json are unsupported")
        for key in ("id", "name", "title", "description", "version"):
            if key in manifest and not isinstance(manifest[key], str):
                fail(f"Manifest {key} must be a string")
        source = files["main.js"][0].decode("utf-8")
        if not source.strip() or "\x00" in source:
            fail("main.js must be nonempty UTF-8 JavaScript text; it was not executed")

    def _transaction(self, action, before, plan, request, commit):
        # Save full preimages outside mods before intent, and intent before writes.
        for name, record in before.items():
            with self.fs.directory(self.mods, name) as fd:
                _, contents = self._clean(fd, record)
            for path, data in contents.items():
                self._store(self.work, "backup/" + name + "/" + path, data, 0o600)
            if record.get("kind") == "git":
                with self.fs.directory(self.mods, name) as fd:
                    _, metadata = self._git_snapshot(fd)
                for path, data in metadata.items():
                    if path in {"index", "HEAD", "refs/heads/" + record["branch"], "logs/HEAD", "logs/refs/heads/" + record["branch"]}:
                        self._store(self.work, "backup-git/" + name + "/" + path, data, 0o600)
        for name, (_, files) in plan.items():
            for path, (data, mode) in files.items():
                self._store(self.work, "staged/" + name + "/" + path, data, mode)
        if not self.fs.exists(self.state, "registry.json"):
            self._save_registry()
        transaction = {"version": 1, "action": action, "request": request, "commit": commit, "workspace": self.work_name, "before": before, "plan": {name: {"modFolder": folder, "files": {path: {"sha256": digest(data), "mode": mode} for path, (data, mode) in files.items()}} for name, (folder, files) in plan.items()}, "notice": "Interrupted writes require verified recovery; backups are not executed"}
        self.intent = encode(transaction)
        self._store(self.work, "transaction-intent.json", self.intent, 0o600)
        info = self.fs.atomic(self.state, "transaction.json", self.intent, expected=None)
        self.intent_stamp = (digest(self.intent), identity(info))

    def _store(self, base, path, data, mode):
        with self.fs.parent(base, path, create=True) as (parent, name):
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
            try:
                self.fs.write_fd(fd, data)
                os.fchmod(fd, mode)
                os.fsync(fd)
                os.fsync(parent)
            finally:
                os.close(fd)

    def _live_fd(self, name, expected):
        self._check()
        fd = self.fs.open_dir(self.mods, name)
        try:
            if identity(os.fstat(fd)) != expected:
                fail("Target directory swap detected")
            for path, inode in self.live_dirs.get(name, {}).items():
                with self.fs.directory(fd, path) as child:
                    if identity(os.fstat(child)) != inode:
                        fail("Nested directory swap detected: " + path)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _assert_parent(self, name, root_inode, path, parent):
        self._check()
        if identity(os.stat(name, dir_fd=self.mods, follow_symlinks=False)) != root_inode:
            fail("Target directory swap detected")
        relative = "/".join(parts(path)[:-1])
        expected = self.live_dirs[name].get(relative) if relative else root_inode
        if identity(os.fstat(parent)) != expected:
            fail("Mutation parent directory identity conflict: " + path)

    def _check_saved_file(self, path, data, mode, inode):
        current, info = self.fs.read(self.work, path)
        if current != data or identity(info) != inode or stat.S_IMODE(info.st_mode) != mode:
            fail("Preserved file identity or content conflict: " + path)

    def _retire_file(self, name, root_inode, path, data, mode, inode):
        # Rollback also moves first and verifies afterwards. Never unlink an
        # unchecked live dentry, even if an earlier read matched the baseline.
        destination = "retired/" + uuid.uuid4().hex
        with close_fd(self._live_fd(name, root_inode)) as root:
            with self.fs.parent(root, path) as (parent, leaf), self.fs.parent(self.work, destination, create=True) as (saved, target):
                self._assert_parent(name, root_inode, path, parent)
                rename_exclusive(parent, leaf, saved, target)
                self.preserved.append((destination, data, mode, inode))
                self._check_saved_file(destination, data, mode, inode)
                self.live_files[name].pop(path, None)
                os.fsync(parent)
                os.fsync(saved)

    def _new_directory(self, name, root_inode=None, path=None):
        # Know the new inode before publishing it, so a post-mkdir stat cannot
        # adopt a directory that another writer substituted.
        temporary = "directory-" + uuid.uuid4().hex
        os.mkdir(temporary, 0o755, dir_fd=self.work)
        with self.fs.directory(self.work, temporary) as staged:
            token = identity(os.fstat(staged))
            os.fsync(staged)
        os.fsync(self.work)
        if path is None:
            self.live_dirs[name] = {}
            self.live_files[name] = {}

        def undo():
            self._move_directory(name, root_inode or token, path, token, restore=False)

        if path is None:
            self._check()
            rename_exclusive(self.work, temporary, self.mods, name)
            self.undo.append(undo)
            os.fsync(self.mods)
        else:
            with close_fd(self._live_fd(name, root_inode)) as root:
                with self.fs.parent(root, path) as (parent, leaf):
                    self._assert_parent(name, root_inode, path, parent)
                    rename_exclusive(self.work, temporary, parent, leaf)
                    self.undo.append(undo)
                    self.live_dirs[name][path] = token
                    os.fsync(parent)
        os.fsync(self.work)
        return token

    def _mkdir_live(self, name):
        # The transaction staged EVERY file before publication. One atomic,
        # no-overwrite rename makes the complete package visible to the host.
        with self.fs.directory(self.work, "staged/" + name) as prepared:
            snapshot, contents = self.fs.snapshot(prepared)
        files = self.install_files
        if set(contents) != set(files) or any(contents[p] != data or snapshot["files"][p]["mode"] != mode for p, (data, mode) in files.items()):
            fail("Whole-package staging changed")
        self.live_dirs[name] = dict(snapshot["directories"])
        self.live_files[name] = dict(snapshot["files"])
        self.touched.add(name)
        def undo():
            destination = "retired-package-" + name
            self._check()
            rename_exclusive(self.mods, name, self.work, destination)
            with self.fs.directory(self.work, destination) as saved:
                if self.fs.snapshot(saved) != (snapshot, contents):
                    fail("Published package changed; whole directory retained for recovery")
            os.fsync(self.mods)
            os.fsync(self.work)
        self._check()
        with self.fs.directory(self.work, "staged") as staged:
            rename_exclusive(staged, name, self.mods, name)
            self.undo.append(undo)
            os.fsync(self.mods)
            os.fsync(staged)
        return snapshot["inode"]

    def _move_directory(self, name, root_inode, path, inode, restore=True):
        destination = "displaced-dirs/" + name + "/" + digest((path or "").encode())

        def check_saved():
            with self.fs.directory(self.work, destination) as saved:
                if identity(os.fstat(saved)) != inode or os.listdir(saved):
                    fail("Preserved directory identity or content conflict")

        def undo():
            check_saved()
            if path is None:
                self._check()
                with self.fs.parent(self.work, destination) as (saved, leaf):
                    rename_exclusive(saved, leaf, self.mods, name)
                    os.fsync(self.mods)
                    os.fsync(saved)
            else:
                with close_fd(self._live_fd(name, root_inode)) as root:
                    with self.fs.parent(root, path) as (parent, leaf), self.fs.parent(self.work, destination) as (saved, old):
                        self._assert_parent(name, root_inode, path, parent)
                        rename_exclusive(saved, old, parent, leaf)
                        self.live_dirs[name][path] = inode
                        os.fsync(parent)
                        os.fsync(saved)

        with self.fs.parent(self.work, destination, create=True) as (saved, target):
            if path is None:
                self._check()
                rename_exclusive(self.mods, name, saved, target)
                if restore:
                    self.undo.append(undo)
                self.preserved_dirs.append((destination, inode))
                check_saved()
                os.fsync(self.mods)
            else:
                with close_fd(self._live_fd(name, root_inode)) as root:
                    with self.fs.parent(root, path) as (parent, leaf):
                        self._assert_parent(name, root_inode, path, parent)
                        rename_exclusive(parent, leaf, saved, target)
                        if restore:
                            self.undo.append(undo)
                        self.preserved_dirs.append((destination, inode))
                        self.live_dirs[name].pop(path)
                        check_saved()
                        os.fsync(parent)
            os.fsync(saved)

    def _write_live(self, name, root_inode, path, data, mode, previous=None):
        self.touched.add(name)
        # Finish and sync a private regular file before touching the live path.
        staged = "publish/" + uuid.uuid4().hex
        self._store(self.work, staged, data, mode)
        checked, info = self.fs.read(self.work, staged)
        inode = identity(info)
        if checked != data or stat.S_IMODE(info.st_mode) != mode:
            fail("Publication staging changed")
        components = parts(path)
        for count in range(1, len(components)):
            directory = "/".join(components[:count])
            if directory not in self.live_dirs[name]:
                self._new_directory(name, root_inode, directory)
        if previous is not None:
            self._remove_live_file(name, root_inode, path, *previous)

        def undo():
            self._retire_file(name, root_inode, path, data, mode, inode)

        with close_fd(self._live_fd(name, root_inode)) as root:
            with self.fs.parent(root, path) as (parent, leaf), self.fs.parent(self.work, staged) as (source, temporary):
                self._assert_parent(name, root_inode, path, parent)
                os.link(temporary, leaf, src_dir_fd=source, dst_dir_fd=parent, follow_symlinks=False)
                self.undo.append(undo)
                self.live_files[name][path] = {"sha256": digest(data), "mode": mode, "size": len(data), "inode": inode}
                os.unlink(temporary, dir_fd=source)
                os.fsync(parent)
                os.fsync(source)
        self._check()

    def _remove_live_file(self, name, root_inode, path, expected, mode, inode):
        self.touched.add(name)
        destination = "displaced/" + name + "/" + path

        def undo():
            self._check_saved_file(destination, expected, mode, inode)
            with close_fd(self._live_fd(name, root_inode)) as root:
                with self.fs.parent(root, path) as (parent, leaf), self.fs.parent(self.work, destination) as (saved, old):
                    self._assert_parent(name, root_inode, path, parent)
                    rename_exclusive(saved, old, parent, leaf)
                    self.live_files[name][path] = {"sha256": digest(expected), "mode": mode, "size": len(expected), "inode": inode}
                    os.fsync(parent)
                    os.fsync(saved)

        with close_fd(self._live_fd(name, root_inode)) as root:
            with self.fs.parent(root, path) as (parent, leaf), self.fs.parent(self.work, destination, create=True) as (saved, target):
                self._assert_parent(name, root_inode, path, parent)
                rename_exclusive(parent, leaf, saved, target)
                self.undo.append(undo)
                self.preserved.append((destination, expected, mode, inode))
                self.live_files[name].pop(path, None)
                self._check_saved_file(destination, expected, mode, inode)
                os.fsync(parent)
                os.fsync(saved)

    def _prune(self, name, root_inode, directories):
        for path in sorted(directories, key=lambda p: (p.count("/"), p), reverse=True):
            self._move_directory(name, root_inode, path, directories[path])

    def _record(self, name, repository, recipe, folder, commit, snapshot):
        # The snapshot is the one that matched staged bytes and published inodes.
        return {"kind": "package", "id": name, "repository": repository, "recipePath": recipe, "modFolder": folder, "path": self.home + "/mods/" + name, "commit": commit, "identityToken": uuid.uuid4().hex, **snapshot}

    def _verify_package(self, name, inode, files):
        with close_fd(self._live_fd(name, inode)) as fd:
            snapshot, contents = self.fs.snapshot(fd, exclude={".git"})
        extras = set(contents) - set(files)
        if extras or snapshot["directories"] != self.live_dirs[name]:
            fail("Unexpected files or directories appeared during commit")
        for path, (data, mode) in files.items():
            if contents.get(path) != data or snapshot["files"].get(path) != self.live_files[name].get(path) or snapshot["files"][path]["mode"] != mode:
                fail("Live content verification failed: " + path)
        snapshot["files"] = {p: v for p, v in snapshot["files"].items() if p in files}
        return snapshot

    def _finish(self):
        self._check()
        self._save_registry()
        self.fs.retire(self.state, "transaction.json", self.intent_stamp)
        os.fsync(self.state)
        self.undo.clear()

    def _rollback(self, original):
        try:
            for undo in reversed(self.undo):
                undo()
            # Restore the original inodes. Never adopt a changed rollback object.
            for name in self.touched & original["mods"].keys():
                with self.fs.directory(self.mods, name) as fd:
                    self._clean(fd, original["mods"][name])
            self.registry = original
            self._save_registry()
            if self.fs.exists(self.state, "transaction.json"):
                self.fs.retire(self.state, "transaction.json", self.intent_stamp)
            os.fsync(self.state)
            self.undo.clear()
        except (SafetyError, OSError) as error:
            self.retain_work = True
            if self.intent is not None and not self.fs.exists(self.state, "transaction.json"):
                info = self.fs.atomic(self.state, "transaction.json", self.intent, expected=None)
                self.intent_stamp = (digest(self.intent), identity(info))
            fail(f"Rollback could not be verified: {error}. Changes are blocked by transaction.json; inspect data/mod-manager/{self.work_name}/transaction-intent.json and its workspace backups before recovery")

    def _cleanup_work(self):
        # Staging contains untrusted git data. Remove by no-follow directory handles,
        # never shutil.rmtree on a path that can be redirected.
        if self.work is None or self.retain_work or self.fs.exists(self.state, "transaction.json"):
            return
        for path, data, mode, inode in self.preserved:
            if self.fs.exists(self.work, path):
                self._check_saved_file(path, data, mode, inode)
        for path, inode in self.preserved_dirs:
            if self.fs.exists(self.work, path):
                with self.fs.directory(self.work, path) as saved:
                    if identity(os.fstat(saved)) != inode or os.listdir(saved):
                        fail("Preserved directory changed; workspace retained for inspection")
        def remove(fd):
            for name in os.listdir(fd):
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    with close_fd(self.fs.open_dir(fd, name)) as child:
                        if identity(os.fstat(child)) != identity(info):
                            fail("Staging directory swap")
                        remove(child)
                    if identity(os.stat(name, dir_fd=fd, follow_symlinks=False)) != identity(info):
                        fail("Staging directory swap")
                    os.rmdir(name, dir_fd=fd)
                else:
                    os.unlink(name, dir_fd=fd)
        self._check()
        remove(self.work)
        if identity(os.stat(self.work_name, dir_fd=self.state, follow_symlinks=False)) != identity(os.fstat(self.work)):
            fail("Staging workspace swap")
        os.rmdir(self.work_name, dir_fd=self.state)

    def _install(self, request):
        repository = normalized_repository(request.get("repository"))
        recipe = request.get("recipePath", "")
        original = parse_json(encode(self.registry), "registry copy")
        transaction = False
        try:
            with close_fd(self._fetch(repository)) as repo:
                commit, tree = self._tree(repo)
                if "expectedCommit" in request and commit != request["expectedCommit"].lower():
                    fail("Repository HEAD does not match expectedCommit; refresh source metadata")
                selection = request.get("modNames")
                if selection is None and "mod.json" in tree and not recipe:
                    selection = [repository.split("/")[1]]
                packages = self._packages(repo, tree, recipe, selection)
            protected, unknown = self._protection(request)
            if unknown:
                fail(unknown[0])
            for name, folder, _ in packages:
                if name in protected:
                    fail(protected[name])
                if any(existing.casefold() == name.casefold() for existing in os.listdir(self.mods)) or name in self.registry["mods"]:
                    fail("Destination already exists or has a source record: " + name)
                if any((r["repository"], r["recipePath"], r["modFolder"]) == (repository, recipe, folder) for r in self.registry["mods"].values()):
                    fail("Source identity is already installed")
            plan = {name: (folder, files) for name, folder, files in packages}
            self._transaction("install", {}, plan, request, commit)
            transaction = True
            protected, unknown = self._protection(request)
            if unknown:
                fail(unknown[0])
            for name, folder, files in packages:
                if name in protected:
                    fail(protected[name])
                self.install_files = files
                inode = self._mkdir_live(name)
                snapshot = self._verify_package(name, inode, files)
                self.registry["mods"][name] = self._record(name, repository, recipe, folder, commit, snapshot)
            self._finish()
            transaction = False
            return {"ids": [name for name, _, _ in packages], "commit": commit}
        except BaseException:
            if transaction:
                self._rollback(original)
                transaction = False
            raise
        finally:
            if not transaction:
                self._cleanup_work()

    def _check_update(self, request):
        record = self._eligible(request, destructive=False)
        try:
            with close_fd(self._fetch(record["repository"])) as repo:
                commit, tree = self._tree(repo, self._source_ref(record))
                self._packages(repo, tree, record["recipePath"], [record["id"]])
                self._fast_forward(repo, record["commit"], commit)
            result = self._discover(request)
            update = commit if commit != record["commit"] else None
            for mod in result["mods"]:
                if mod["id"] == record["id"] and update:
                    mod["updateCommit"] = update
            return {"ok": True, **result, "id": record["id"], "commit": record["commit"], "updateCommit": update}
        finally:
            self._cleanup_work()

    def _source_ref(self, record):
        # Fully qualified refs avoid both main/main and release/stable tag collisions.
        return "refs/remotes/origin/" + record["branch"] if record.get("kind") == "git" else "HEAD"

    def _prepare_git(self, repo, commit):
        self._git(["read-tree", commit], repo, extra_env={"GIT_INDEX_FILE": "candidate.index"})
        index, _ = self.fs.read(repo, "candidate.index")
        pack = self._git(["pack-objects", "--stdout", "--revs"], repo, input_data=(commit + "\n").encode())
        if len(pack) > LIMIT:
            fail("Prepared Git object pack exceeds the supported file size limit")
        packed = self._git(["index-pack", "--stdin"], repo, input_data=pack).decode().strip()
        match = re.fullmatch(r"pack\s+([0-9a-f]{40})", packed)
        if not match or pack[-20:].hex() != match[1]:
            fail("Private Git pack verification failed")
        with close_fd(self.fs.open_dir(repo, ".git")) as git:
            pack_index, _ = self.fs.read(git, "objects/pack/pack-" + match[1] + ".idx")
        self._store(self.work, "git-prepared/index", index, 0o644)
        self._store(self.work, "git-prepared/objects.pack", pack, 0o600)
        self._store(self.work, "git-prepared/objects.idx", pack_index, 0o600)

    def _git_snapshot(self, fd):
        with close_fd(self.fs.open_dir(fd, ".git")) as git:
            return self.fs.snapshot(git)

    def _verify_git_additions(self, before, after):
        old_snapshot, _ = before
        new_snapshot, _ = after
        expected = {"inode": old_snapshot["inode"], "files": {**old_snapshot["files"], **self.git_object_files}, "directories": {**old_snapshot["directories"], **self.created_git_dirs}}
        if new_snapshot != expected:
            fail("Git metadata changed outside the verified object/directory publication")

    def _prepared_git_file(self, leaf):
        data, info = self.fs.read(self.work, "git-prepared/" + leaf)
        expected, entry = self.git_payload[leaf]
        if data != expected or identity(info) != entry["inode"] or stat.S_IMODE(info.st_mode) != entry["mode"]:
            self.retain_work = True
            fail("Prepared Git payload changed before use")
        return data, info

    @contextlib.contextmanager
    def _git_parent(self, record, path):
        """Pin EVERY Git mutation ancestor; no live Git writer gets a path."""
        names = parts(path)
        directories = self.git_directories
        with close_fd(self._live_fd(record["id"], record["inode"])) as root, close_fd(self.fs.open_dir(root, ".git")) as git:
            if identity(os.fstat(git)) != record["git"]["inode"]:
                fail("Git directory identity changed before mutation")
            for count in range(1, len(names)):
                relative = "/".join(names[:count])
                with self.fs.directory(git, relative) as ancestor:
                    if identity(os.fstat(ancestor)) != directories.get(relative):
                        fail("Git metadata ancestor identity conflict: " + relative)
            with self.fs.parent(git, path) as (parent, leaf):
                expected = directories.get("/".join(names[:-1])) if len(names) > 1 else record["git"]["inode"]
                if identity(os.fstat(parent)) != expected:
                    fail("Git mutation parent identity conflict")
                self._check()
                yield git, parent, leaf

    def _prepare_git_parents(self, record, path):
        names = parts(path)
        for count in range(1, len(names)):
            relative = "/".join(names[:count])
            if relative in self.git_directories:
                continue
            private = "git-directory-" + uuid.uuid4().hex
            os.mkdir(private, 0o755, dir_fd=self.work)
            with self.fs.directory(self.work, private) as staged:
                inode = identity(os.fstat(staged))
                os.fsync(staged)
            os.fsync(self.work)
            with self._git_parent(record, relative) as (_, parent, leaf):
                rename_exclusive(self.work, private, parent, leaf)
                self.git_directories[relative] = inode
                self.created_git_dirs[relative] = inode
                os.fsync(parent)
                os.fsync(self.work)

    def _retire_git_file(self, record, path, data, inode, mode):
        saved = "git-retired-" + uuid.uuid4().hex
        with self._git_parent(record, path) as (_, parent, leaf):
            rename_exclusive(parent, leaf, self.work, saved)
            current, info = self.fs.read(self.work, saved)
            if current != data or identity(info) != inode or stat.S_IMODE(info.st_mode) != mode:
                fail("Git metadata retirement conflict; moved file retained at " + saved)
            os.fsync(parent)
            os.fsync(self.work)
        return saved

    def _git_ref(self, record, commit, packed):
        path = "refs/heads/" + record["branch"]
        lock_path = path + ".lock"
        target = (commit + "\n").encode()
        old_entry = packed[0]["files"].get(path)
        old_data = packed[1].get(path)
        if old_data is not None and old_data != (record["commit"] + "\n").encode():
            fail("Git ref CAS baseline changed")
        if old_data is None:
            refs = packed[1].get("packed-refs", b"").splitlines()
            expected = (record["commit"] + " " + path).encode()
            if expected not in refs:
                fail("Git packed ref CAS baseline changed")
        ref_mode = old_entry["mode"] if old_entry is not None else 0o600
        state = {"lock": None, "saved": None, "published": False}
        def undo():
            # Other metadata must still equal the verified pre-ref state. Index
            # rollback runs first; external edits are never auto-adopted.
            with close_fd(self._live_fd(record["id"], record["inode"])) as root:
                snapshot, contents = self._git_snapshot(root)
            excluded = {path, lock_path}
            if {**snapshot, "files": {p: v for p, v in snapshot["files"].items() if p not in excluded}} != {**packed[0], "files": {p: v for p, v in packed[0]["files"].items() if p not in excluded}}:
                fail("Git rollback conflict; external metadata retained")
            if state["published"]:
                with self._git_parent(record, lock_path) as (_, parent, leaf):
                    lock_fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                    state["rollbackLock"] = identity(os.fstat(lock_fd))
                    os.fchmod(lock_fd, 0o600)
                    os.fsync(lock_fd)
                    os.close(lock_fd)
                self._retire_git_file(record, path, target, state["lock"], ref_mode)
                if state["saved"] is not None:
                    self._check_saved_file(state["saved"], old_data, old_entry["mode"], old_entry["inode"])
                    with self._git_parent(record, path) as (_, parent, leaf):
                        rename_exclusive(self.work, state["saved"], parent, leaf)
                        os.fsync(parent)
                self._retire_git_file(record, lock_path, b"", state["rollbackLock"], 0o600)
            else:
                if state["saved"] is not None:
                    self._check_saved_file(state["saved"], old_data, old_entry["mode"], old_entry["inode"])
                    with self._git_parent(record, path) as (_, parent, leaf):
                        rename_exclusive(self.work, state["saved"], parent, leaf)
                        os.fsync(parent)
                if state["lock"] is not None:
                    self._retire_git_file(record, lock_path, target, state["lock"], ref_mode)
            with close_fd(self._live_fd(record["id"], record["inode"])) as root:
                if self._git_snapshot(root) != packed:
                    fail("Git ref rollback readback conflict")
        with self._git_parent(record, lock_path) as (_, parent, leaf):
            lock_fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, ref_mode, dir_fd=parent)
            state["lock"] = identity(os.fstat(lock_fd))
            self.undo.append(undo)
            try:
                self.fs.write_fd(lock_fd, target)
                os.fchmod(lock_fd, ref_mode)
                os.fsync(lock_fd)
                os.fsync(parent)
            finally:
                os.close(lock_fd)
        with self._git_parent(record, path) as (_, parent, leaf):
            if old_entry is None:
                # The branch lock now excludes ordinary ref writers. Do not
                # use the earlier packed-ref snapshot as the current CAS value.
                with self._git_parent(record, "packed-refs") as (_, packed_parent, packed_leaf):
                    data, info = self.fs.read(packed_parent, packed_leaf)
                    entry = {"sha256": digest(data), "size": len(data), "mode": stat.S_IMODE(info.st_mode), "inode": identity(info)}
                    if data != packed[1]["packed-refs"] or entry != packed[0]["files"]["packed-refs"]:
                        fail("Git packed ref changed before CAS; no working files were changed")
            if old_entry is not None:
                saved = "git-original-ref-" + uuid.uuid4().hex
                rename_exclusive(parent, leaf, self.work, saved)
                state["saved"] = saved
                self._check_saved_file(saved, old_data, old_entry["mode"], old_entry["inode"])
                os.fsync(parent)
                os.fsync(self.work)
            elif self.fs.exists(parent, leaf):
                fail("Git ref appeared during CAS; native lock retained")
            self._git_point("ref-retired")
            # Reopen and recheck every ancestor immediately before publication.
        with self._git_parent(record, path) as (_, parent, leaf):
            rename_exclusive(parent, leaf + ".lock", parent, leaf)
            state["published"] = True
            data, info = self.fs.read(parent, leaf)
            if data != target or identity(info) != state["lock"] or stat.S_IMODE(info.st_mode) != ref_mode:
                fail("Git ref publication readback conflict")
            self.git_expected["files"][path] = {"sha256": digest(target), "size": len(target), "mode": ref_mode, "inode": state["lock"]}
            os.fsync(parent)
        self._git_point("ref")

    def _git_begin(self, record, commit, original):
        name = record["id"]
        self.touched.add(name)
        with close_fd(self._live_fd(name, record["inode"])) as fd:
            before = self._git_snapshot(fd)
        if before[0] != self.verified_git_metadata:
            fail("Git metadata changed after eligibility verification")
        self.git_index_baseline = before[0]["files"]["index"]
        self.git_directories = dict(before[0]["directories"])
        self.created_git_dirs = {}
        self.git_object_files = {}
        self._prepare_git_parents(record, "objects/pack/pack-placeholder")
        self._prepare_git_parents(record, "refs/heads/" + record["branch"])
        pack, _ = self._prepared_git_file("objects.pack")
        pack_name = "pack-" + pack[-20:].hex()
        self._git_point("before-objects")
        for leaf, extension in (("objects.pack", ".pack"), ("objects.idx", ".idx")):
            data, _ = self._prepared_git_file(leaf)
            staged = "git-object-" + uuid.uuid4().hex
            self._store(self.work, staged, data, 0o444)
            checked, staged_info = self.fs.read(self.work, staged)
            if checked != data or stat.S_IMODE(staged_info.st_mode) != 0o444:
                fail("Git object publication staging changed")
            path = "objects/pack/" + pack_name + extension
            with self._git_parent(record, path) as (_, parent, target):
                if self.fs.exists(parent, target):
                    existing, info = self.fs.read(parent, target)
                    entry = {"sha256": digest(existing), "size": len(existing), "mode": stat.S_IMODE(info.st_mode), "inode": identity(info)}
                    if existing != data or before[0]["files"].get(path) != entry:
                        fail("Git object destination changed; no object was overwritten")
                else:
                    rename_exclusive(self.work, staged, parent, target)
                    self.git_object_files[path] = {"sha256": digest(data), "size": len(data), "mode": 0o444, "inode": identity(staged_info)}
                    os.fsync(parent)
                    os.fsync(self.work)
        with close_fd(self._live_fd(name, record["inode"])) as fd:
            packed = self._git_snapshot(fd)
        self._verify_git_additions(before, packed)
        self.git_expected = parse_json(encode(packed[0]), "Git expected metadata")
        def undo_objects():
            with close_fd(self._live_fd(name, record["inode"])) as fd:
                if self._git_snapshot(fd) != packed:
                    fail("Git object rollback conflict; prior objects were not deleted")
            original["mods"][name]["git"] = packed[0]
        self.undo.append(undo_objects)
        self._git_point("before-ref")
        self._git_ref(record, commit, packed)

    def _git_point(self, point):
        """Fault-injection boundary for the retained-checkout transaction."""

    def _git_index(self, record):
        staged, _ = self._prepared_git_file("index")
        with self._git_parent(record, "index") as (_, git, leaf):
            old, info = self.fs.read(git, leaf)
            if self.git_index_baseline != {"sha256": digest(old), "size": len(old), "mode": stat.S_IMODE(info.st_mode), "inode": identity(info)}:
                fail("Git index changed before publication")
        index_mode = stat.S_IMODE(info.st_mode)
        state = {"retired": False, "published": False}
        with self._git_parent(record, "index.lock") as (_, git, leaf):
            lock_fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, index_mode, dir_fd=git)
            lock_inode = identity(os.fstat(lock_fd))
            def undo():
                if state["retired"]:
                    self._check_saved_file("original-index", old, stat.S_IMODE(info.st_mode), identity(info))
                if state["published"]:
                    with self._git_parent(record, "index.lock") as (_, target, leaf):
                        rollback_fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target)
                        rollback_inode = identity(os.fstat(rollback_fd))
                        os.fchmod(rollback_fd, 0o600)
                        os.fsync(rollback_fd)
                        os.close(rollback_fd)
                    self._retire_git_file(record, "index", staged, lock_inode, index_mode)
                if state["retired"]:
                    with self._git_parent(record, "index") as (_, target, leaf):
                        rename_exclusive(self.work, "original-index", target, leaf)
                        os.fsync(target)
                self._retire_git_file(record, "index.lock", b"" if state["published"] else staged, rollback_inode if state["published"] else lock_inode, 0o600 if state["published"] else index_mode)
            self.undo.append(undo)
            try:
                self.fs.write_fd(lock_fd, staged)
                os.fchmod(lock_fd, index_mode)
                os.fsync(lock_fd)
                os.fsync(git)
            finally:
                os.close(lock_fd)
        with self._git_parent(record, "index") as (_, git, leaf):
            rename_exclusive(git, leaf, self.work, "original-index")
            state["retired"] = True
            self._check_saved_file("original-index", old, stat.S_IMODE(info.st_mode), identity(info))
            os.fsync(git)
            os.fsync(self.work)
        self._git_point("index-retired")
        with self._git_parent(record, "index") as (_, git, leaf):
            rename_exclusive(git, "index.lock", git, leaf)
            state["published"] = True
            data, checked = self.fs.read(git, leaf)
            if data != staged or identity(checked) != lock_inode or stat.S_IMODE(checked.st_mode) != index_mode:
                fail("Git index publication readback conflict")
            self.git_expected["files"]["index"] = {"sha256": digest(staged), "size": len(staged), "mode": index_mode, "inode": lock_inode}
            os.fsync(git)
        self._git_point("index")

    def _fast_forward(self, repo, old, new):
        try:
            self._git(["merge-base", "--is-ancestor", old, new], repo)
        except SafetyError:
            fail("Update is not a verified fast-forward; history was rewritten or the installed commit is missing")

    def _prepare_update(self, request):
        if not {"expectedCommit", "path", "identityToken"} <= set(request):
            fail("Update preparation requires expectedCommit, displayed path and identityToken")
        record = self._eligible(request, destructive=False)
        try:
            with close_fd(self._fetch(record["repository"])) as repo:
                commit, tree = self._tree(repo, self._source_ref(record))
                if "targetCommit" in request and commit != request["targetCommit"].lower():
                    fail("Repository HEAD does not match targetCommit; check updates again")
                packages = self._packages(repo, tree, record["recipePath"], [record["id"]])
                self._fast_forward(repo, record["commit"], commit)
                if record.get("kind") == "git":
                    self._prepare_git(repo, commit)
            name, folder, files = packages[0]
            if folder != record["modFolder"]:
                fail("Update source folder mismatch")
            for path, (data, mode) in files.items():
                self._store(self.work, "prepared/" + name + "/" + path, data, mode)
            with self.fs.directory(self.work, "prepared/" + name) as staged:
                snapshot, contents = self.fs.snapshot(staged)
            if any(contents.get(path) != data or snapshot["files"][path]["mode"] != mode for path, (data, mode) in files.items()):
                fail("Prepared files changed")
            token = self.work_name.removeprefix("work-")
            stage = {"version": 1, "token": token, "workspaceInode": identity(os.fstat(self.work)), "before": record, "commit": commit, "folder": folder, "snapshot": snapshot}
            if record.get("kind") == "git":
                with self.fs.directory(self.work, "git-prepared") as prepared_git:
                    stage["gitPrepared"] = self.fs.snapshot(prepared_git)[0]
            manifest = encode(stage)
            info = self.fs.atomic(self.work, "prepared.json", manifest, expected=None)
            receipt = {"version": 1, "token": token, "workspaceInode": stage["workspaceInode"], "manifestSha256": digest(manifest), "manifestInode": identity(info)}
            self.fs.atomic(self.state, "stage-" + token + ".json", encode(receipt), expected=None)
            self._eligible(request, destructive=False)
            self._compare_registry()
            os.fsync(self.state)
            # A closed view can leave this private workspace outside mods.
            # Inspect prepared.json before manual cleanup; never delete unknown
            # workspaces or a workspace referenced by transaction.json.
            self.retain_work = True
            return {"ok": True, "stageToken": token, "id": name, "ids": [name], "commit": commit, "expectedCommit": record["commit"]}
        finally:
            self._cleanup_work()

    def _stage_files(self, stage):
        try:
            manifest = "consumed.json" if self.stage_consumed else "prepared.json"
            data, info = self.fs.read(self.work, manifest)
            if (data, identity(info)) != self.stage_stamp:
                fail("Prepared stage manifest changed")
            with self.fs.directory(self.work, "prepared/" + stage["before"]["id"]) as fd:
                snapshot, contents = self.fs.snapshot(fd)
            if snapshot != stage["snapshot"]:
                fail("Prepared stage changed; inspect the retained workspace")
            files = {path: (data, snapshot["files"][path]["mode"]) for path, data in contents.items()}
            self._validate_package(files)
            if stage["before"].get("kind") == "git":
                with self.fs.directory(self.work, "git-prepared") as git:
                    metadata, payload = self.fs.snapshot(git)
                    if metadata != stage["gitPrepared"]:
                        fail("Prepared Git index/object pack changed")
                    self.git_payload = {p: (data, metadata["files"][p]) for p, data in payload.items()}
            return files
        except (SafetyError, OSError):
            self.retain_work = True
            raise

    def _open_stage(self, request, record):
        self.work_name = "work-" + request["stageToken"]
        try:
            self.work = self.fs.open_dir(self.state, self.work_name)
        except FileNotFoundError:
            fail("Update stage is missing or already consumed; prepare again")
        self.retain_work = True  # Never clean an unverified or altered stage.
        if self.fs.exists(self.work, "consumed.json"):
            fail("Update stage was already consumed; prepare again")
        data, info = self.fs.read(self.work, "prepared.json")
        receipt_path = "stage-" + request["stageToken"] + ".json"
        receipt_data, receipt_info = self.fs.read(self.state, receipt_path)
        receipt = parse_json(receipt_data, "stage receipt")
        if receipt != {"version": 1, "token": request["stageToken"], "workspaceInode": identity(os.fstat(self.work)), "manifestSha256": digest(data), "manifestInode": identity(info)} or type(receipt["version"]) is not int:
            fail("Prepared stage provenance changed; workspace retained")
        self.stage_stamp = (data, identity(info))
        stage = parse_json(data, "prepared stage")
        required = {"version", "token", "workspaceInode", "before", "commit", "folder", "snapshot"}
        if record.get("kind") == "git":
            required.add("gitPrepared")
        if not isinstance(stage, dict) or set(stage) != required or type(stage["version"]) is not int or stage["version"] != 1:
            fail("Invalid prepared stage")
        if stage["token"] != request["stageToken"] or stage["workspaceInode"] != identity(os.fstat(self.work)) or stage["before"] != record:
            fail("Stale stage identity; original ownership or installed commit changed")
        self._validate_record(record["id"], {**record, **stage["snapshot"], "commit": stage["commit"]})
        if stage["folder"] != record["modFolder"] or ("targetCommit" in request and request["targetCommit"].lower() != stage["commit"]):
            fail("Prepared stage targetCommit or source identity mismatch")
        files = self._stage_files(stage)
        self._eligible(request)
        self._compare_registry()
        # Consumption is durable and single use. Compare the moved manifest to
        # the SAME bytes used above, not a fresh, possibly substituted identity.
        rename_exclusive(self.state, receipt_path, self.work, "receipt.json")
        moved_receipt, current_receipt = self.fs.read(self.work, "receipt.json")
        if moved_receipt != receipt_data or identity(current_receipt) != identity(receipt_info):
            fail("Prepared stage receipt changed during consumption")
        os.fsync(self.state)
        rename_exclusive(self.work, "prepared.json", self.work, "consumed.json")
        self.stage_consumed = True
        moved, current = self.fs.read(self.work, "consumed.json")
        if moved != data or identity(current) != identity(info):
            fail("Prepared stage manifest changed during consumption")
        os.fsync(self.work)
        self.retain_work = False
        return stage, files

    def _update(self, request):
        if "stageToken" not in request:
            fail("Update requires stageToken from prepare-update; refresh runtime dependencies before committing")
        if not {"expectedCommit", "path", "identityToken"} <= set(request):
            fail("Update requires expectedCommit, displayed path and identityToken")
        record = self._eligible(request)
        original = parse_json(encode(self.registry), "registry copy")
        transaction = False
        try:
            stage, files = self._open_stage(request, record)
            name, folder, commit = record["id"], stage["folder"], stage["commit"]
            if commit == record["commit"]:
                return {"ids": [name], "commit": commit}
            self._transaction("update", {name: record}, {name: (folder, files)}, request, commit)
            transaction = True
            self._eligible(request)  # Fresh runtime context and current metadata.
            self._stage_files(stage)
            with self.fs.directory(self.mods, name) as fd:
                snapshot, contents = self._clean(fd, record)
            if record.get("kind") == "git":
                self._git_begin(record, commit, original)
            # Retire old paths before publication so files can become directories
            # and directories can become files. Rollback restores these last.
            obsolete = set(record["files"]) - set(files)
            for path in sorted(obsolete):
                baseline = snapshot["files"][path]
                self._remove_live_file(name, record["inode"], path, contents[path], baseline["mode"], baseline["inode"])
            wanted_dirs = {"/".join(parts(path)[:n]) for path in files for n in range(1, len(parts(path)))}
            self._prune(name, record["inode"], {p: i for p, i in snapshot["directories"].items() if p not in wanted_dirs})
            for path in sorted(files, key=lambda p: (p == "main.js", p)):
                data, mode = files[path]
                previous = (contents[path], snapshot["files"][path]["mode"], snapshot["files"][path]["inode"]) if path in contents else None
                if previous and previous[:2] == (data, mode):
                    continue
                self._write_live(name, record["inode"], path, data, mode, previous)
            if record.get("kind") == "git":
                self._git_point("files")
                self._git_index(record)
            verified = self._verify_package(name, record["inode"], files)
            updated = self._record(name, record["repository"], record["recipePath"], folder, commit, verified)
            if record.get("kind") == "git":
                with self.fs.directory(self.mods, name) as fd:
                    checked, _, metadata, current = self._inspect_git(fd, record["branch"], "https://github.com/" + record["repository"] + ".git")
                if checked != verified or current != commit or metadata != self.git_expected:
                    fail("Git checkout final readback failed; metadata changed outside the verified plan")
                updated.update(kind="git", branch=record["branch"], git=metadata)
            self.registry["mods"][name] = updated
            self._finish()
            transaction = False
            return {"ids": [name], "commit": commit}
        except BaseException:
            if transaction:
                self._rollback(original)
                transaction = False
            raise
        finally:
            if not transaction:
                self._cleanup_work()

    def _uninstall_git(self, request, record):
        archive = self._archive_path(record)
        if request.get("archiveGit") is not True or request.get("archivePath") != archive:
            fail("Git uninstall requires confirmation of archivePath: " + archive + "; entire checkout and history will be retained outside mods")
        leaf = archive.rsplit("/", 1)[1]
        if self.fs.exists(self.state, leaf):
            fail("Archive destination already exists; nothing was overwritten")
        original = parse_json(encode(self.registry), "registry copy")
        self._workspace()
        transaction = False
        try:
            name = record["id"]
            self._transaction("archive-uninstall", {name: record}, {}, request, record["commit"])
            transaction = True
            self._eligible(request)
            def undo():
                with self.fs.directory(self.state, leaf) as saved:
                    self._clean(saved, record)
                self._check()
                rename_exclusive(self.state, leaf, self.mods, name)
                os.fsync(self.mods)
                os.fsync(self.state)
            self._check()
            rename_exclusive(self.mods, name, self.state, leaf)
            self.undo.append(undo)
            self.touched.add(name)
            self._git_point("archive")
            with self.fs.directory(self.state, leaf) as saved:
                self._clean(saved, record)
            os.fsync(self.mods)
            os.fsync(self.state)
            del self.registry["mods"][name]
            self.registry["history"].append(record)
            self._finish()
            transaction = False
            return {"ids": [name], "commit": record["commit"], "archivePath": archive, "message": "Checkout and complete Git history retained at " + archive}
        except BaseException:
            if transaction:
                self._rollback(original)
                transaction = False
            raise
        finally:
            if not transaction:
                self._cleanup_work()

    def _uninstall(self, request):
        if not {"expectedCommit", "path", "identityToken"} <= set(request):
            fail("Uninstall confirmation requires expectedCommit, displayed path and identityToken from discovery")
        record = self._eligible(request)
        if record.get("kind") == "git":
            return self._uninstall_git(request, record)
        original = parse_json(encode(self.registry), "registry copy")
        self._workspace()
        transaction = False
        try:
            name = record["id"]
            self._transaction("uninstall", {name: record}, {}, request, record["commit"])
            transaction = True
            self._eligible(request)
            with self.fs.directory(self.mods, name) as fd:
                snapshot, contents = self._clean(fd, record)
            # main.js disappears first; this is not proof that runtime copies stop.
            for path in sorted(contents, key=lambda p: (p != "main.js", p)):
                baseline = snapshot["files"][path]
                self._remove_live_file(name, record["inode"], path, contents[path], baseline["mode"], baseline["inode"])
            self._prune(name, record["inode"], snapshot["directories"])
            self._move_directory(name, record["inode"], None, record["inode"])
            del self.registry["mods"][name]
            self.registry["history"].append(record)
            self._finish()
            transaction = False
            return {"ids": [name], "commit": record["commit"]}
        except BaseException:
            if transaction:
                self._rollback(original)
                transaction = False
            raise
        finally:
            if not transaction:
                self._cleanup_work()


def main():
    try:
        if len(sys.argv) != 3:
            fail("Usage: operations.py <absolute appHome> '<JSON request>'")
        if len(sys.argv[2]) > 1024 * 1024:
            fail("Request exceeds the size limit")
        request = parse_json(sys.argv[2], "request")
        result = Operations(sys.argv[1]).run(request)
    except (SafetyError, OSError, ValueError, UnicodeError, TypeError, KeyError, OverflowError, RecursionError) as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
