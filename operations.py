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

    def atomic(self, base, name, data):
        # This is for manager metadata only, never for replacing live directories.
        if len(data) > LIMIT:
            fail("Manager metadata exceeds the supported size limit")
        self.check()
        if self.exists(base, name):
            self.read(base, name)
        temp = ".write-" + uuid.uuid4().hex
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=base)
        try:
            self.write_fd(fd, data)
            os.fsync(fd)
            self.check()
            os.replace(temp, name, src_dir_fd=base, dst_dir_fd=base)
            os.fsync(base)
            return os.fstat(fd)
        finally:
            os.close(fd)
            if self.exists(base, temp):
                os.unlink(temp, dir_fd=base)

    @staticmethod
    def write_fd(fd, data):
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if not count:
                fail("Short file write")
            view = view[count:]

    def snapshot(self, base):
        files, directories, contents = {}, {}, {}

        def visit(fd, prefix):
            for name in sorted(os.listdir(fd)):
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
        allowed = {"action", "repository", "recipePath", "expectedCommit", "targetCommit", "stageToken", "modNames", "id", "path", "identityToken", "dependencies", "runtimeKnown"}
        if set(request) - allowed:
            fail("Unknown request fields: " + ", ".join(sorted(set(request) - allowed)))
        action = request.get("action")
        if action not in {"discover", "install", "check-update", "prepare-update", "update", "uninstall"}:
            fail("Unknown action")
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
            with self.fs.directory(self.fs.root, "mods", create=True) as fd:
                self.mods = os.dup(fd)
            with self.fs.directory(self.fs.root, "data", create=True) as fd:
                self.data = os.dup(fd)
            with self.fs.directory(self.data, "mod-manager", create=True) as fd:
                self.state = os.dup(fd)
            if os.fstat(self.mods).st_dev != os.fstat(self.state).st_dev:
                fail("Unsupported filesystem: staging and live mods must share a device")
            self._acquire_lock()
            self.registry, self.registry_stamp = self._read_registry(self.state, stamped=True)
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
            return {"ok": True, **self._discover(request), **result, "notice": NOTICE, "message": NOTICE}
        except (SafetyError, OSError, subprocess.SubprocessError, UnicodeError, ValueError, TypeError, KeyError, OverflowError, RecursionError) as error:
            return {"ok": False, "error": str(error) or type(error).__name__}
        finally:
            self.close()

    def _acquire_lock(self):
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
            if value != {"version": 1} or type(value.get("version")) is not int or identity(current) != identity(info):
                fail("Corrupt lifecycle lock; inspect data/mod-manager/lock before recovery")
        else:
            self.fs.write_fd(self.lock, encode({"version": 1}))
            os.fsync(self.lock)
        self._check()

    def _read_registry(self, state, stamped=False):
        if not self.fs.exists(state, "registry.json"):
            if self.fs.exists(state, "transaction.json"):
                fail("Missing registry with an interrupted transaction; recover transaction.json before writes")
            # A marker prevents a deleted registry from silently resetting ownership.
            if self.fs.exists(state, "initialized"):
                fail("Missing registry in initialized store; restore registry.json from a verified backup")
            empty = {"version": 1, "mods": {}, "history": []}
            return (empty, None) if stamped else empty
        data, info = self.fs.read(state, "registry.json")
        value = parse_json(data, "registry.json")
        if not isinstance(value, dict) or set(value) != {"version", "mods", "history"} or type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["mods"], dict) or not isinstance(value["history"], list):
            fail("Corrupt registry; restore data/mod-manager/registry.json from a verified backup")
        for name, record in value["mods"].items():
            self._validate_record(name, record)
        for record in value["history"]:
            if not isinstance(record, dict) or not valid_id(record.get("id")):
                fail("Corrupt registry history")
            self._validate_record(record["id"], record)
        return (value, (digest(data), identity(info))) if stamped else value

    def _validate_record(self, name, record):
        if not valid_id(name) or not isinstance(record, dict):
            fail("Corrupt registry record")
        required = {"id", "repository", "recipePath", "modFolder", "path", "commit", "files", "directories", "inode", "identityToken"}
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
        info = self.fs.atomic(self.state, "registry.json", data)
        self.registry_stamp = (digest(data), identity(info))
        self.fs.atomic(self.state, "initialized", b"1\n")

    def _protection(self, request):
        protected = {"mod-manager": "The running manager is protected"}
        self.shipped = set()
        unknown = []
        for name in request.get("dependencies", []):
            protected[name] = "Active runtime dependency"

        def collect(value, reason):
            if isinstance(value, dict):
                for key, child in value.items():
                    collect(key, reason)
                    collect(child, reason)
            elif isinstance(value, list):
                for child in value:
                    collect(child, reason)
            elif isinstance(value, str):
                for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
                    protected.setdefault(token, reason)

        def read_metadata(fd, name, reason):
            try:
                data, _ = self.fs.read(fd, name)
                value = parse_json(data, name)
                if not isinstance(value, (dict, list)):
                    fail("metadata must be an object or array")
                collect(value, reason)
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
        warnings = []
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
                    if lock_value != {"version": 1} or type(lock_value.get("version")) is not int:
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
        return {"mods": mods, "warnings": warnings}

    def _clean(self, fd, record):
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

    def _git(self, arguments, cwd_fd):
        executable = shutil.which("git")
        if not executable:
            fail("git is unavailable; install a trusted local git separately. No tool was downloaded")
        env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": "/nonexistent", "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/usr/bin/false", "GIT_ALLOW_PROTOCOL": "https", "GIT_LFS_SKIP_SMUDGE": "1"}
        command = [executable, "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", *arguments]
        result = subprocess.run(command, preexec_fn=lambda: os.fchdir(cwd_fd), pass_fds=(cwd_fd,), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
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

    def _tree(self, repo):
        commit = self._git(["rev-parse", "--verify", "HEAD^{commit}"], repo).decode().strip()
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
        if manifest.get("place") != "none":
            fail("Unsupported manifest placement: place must be 'none' to prevent automatic docking; layouts will not be changed")
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
        for name, (_, files) in plan.items():
            for path, (data, mode) in files.items():
                self._store(self.work, "staged/" + name + "/" + path, data, mode)
        if not self.fs.exists(self.state, "registry.json"):
            self._save_registry()
        transaction = {"version": 1, "action": action, "request": request, "commit": commit, "workspace": self.work_name, "before": before, "plan": {name: {"modFolder": folder, "files": {path: {"sha256": digest(data), "mode": mode} for path, (data, mode) in files.items()}} for name, (folder, files) in plan.items()}, "notice": "Interrupted writes require verified recovery; backups are not executed"}
        self.intent = encode(transaction)
        self.fs.atomic(self.state, "transaction.json", self.intent)

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
        return self._new_directory(name)

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
        return {"id": name, "repository": repository, "recipePath": recipe, "modFolder": folder, "path": self.home + "/mods/" + name, "commit": commit, "identityToken": uuid.uuid4().hex, **snapshot}

    def _verify_package(self, name, inode, files):
        with close_fd(self._live_fd(name, inode)) as fd:
            snapshot, contents = self.fs.snapshot(fd)
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
        os.unlink("transaction.json", dir_fd=self.state)
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
                os.unlink("transaction.json", dir_fd=self.state)
            os.fsync(self.state)
            self.undo.clear()
        except (SafetyError, OSError) as error:
            self.retain_work = True
            if self.intent is not None and not self.fs.exists(self.state, "transaction.json"):
                self.fs.atomic(self.state, "transaction.json", self.intent)
            fail(f"Rollback could not be verified: {error}. Changes are blocked by transaction.json; inspect its workspace backups before recovery")

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
                inode = self._mkdir_live(name)
                for path in sorted(files, key=lambda p: (p == "main.js", p)):
                    data, mode = files[path]
                    self._write_live(name, inode, path, data, mode)
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
                commit, tree = self._tree(repo)
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
                commit, tree = self._tree(repo)
                if "targetCommit" in request and commit != request["targetCommit"].lower():
                    fail("Repository HEAD does not match targetCommit; check updates again")
                packages = self._packages(repo, tree, record["recipePath"], [record["id"]])
                self._fast_forward(repo, record["commit"], commit)
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
            manifest = encode(stage)
            info = self.fs.atomic(self.work, "prepared.json", manifest)
            receipt = {"version": 1, "token": token, "workspaceInode": stage["workspaceInode"], "manifestSha256": digest(manifest), "manifestInode": identity(info)}
            self.fs.atomic(self.state, "stage-" + token + ".json", encode(receipt))
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
            verified = self._verify_package(name, record["inode"], files)
            updated = self._record(name, record["repository"], record["recipePath"], folder, commit, verified)
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

    def _uninstall(self, request):
        if not {"expectedCommit", "path", "identityToken"} <= set(request):
            fail("Uninstall confirmation requires expectedCommit, displayed path and identityToken from discovery")
        record = self._eligible(request)
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
