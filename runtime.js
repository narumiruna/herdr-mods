/** @import { ExecResult } from "herdr" */
/** @typedef {(command: string, args?: string[], options?: {cwd?: string, timeout?: number}) => Promise<ExecResult>} Exec */

// Herdr lacks lstat and atomic no-clobber rename. This trusted standard-library helper supplies
// those primitives. Isolated Python ignores PYTHONPATH/site hooks; uv never installs dependencies.
// All input is JSON, not executable source. No repository code is imported or run.
const HELPER = `
import ctypes
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

request = json.loads(sys.argv[1])
root = os.path.abspath(request["root"])
mods = os.path.join(root, "mods")
work = os.path.join(root, "data", "mod-manager")
lock = os.path.join(work, "lock")
action = request["action"]
args = request.get("args", [])

def kind(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return "missing"
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        return "link"
    if stat.S_ISDIR(info.st_mode):
        return "directory"
    if stat.S_ISREG(info.st_mode):
        return "file"
    return "other"

def check():
    for path in [root, mods, os.path.join(root, "data"), work]:
        if kind(path) not in ["directory", "missing"]:
            raise RuntimeError("Unsafe directory: " + path)

def staging(path):
    path = os.path.abspath(path)
    if os.path.normcase(os.path.dirname(path)) != os.path.normcase(work) or not os.path.basename(path).startswith("install."):
        raise RuntimeError("Unexpected staging path")
    if kind(path) != "directory":
        raise RuntimeError("Staging directory is missing or is a link")

def publish(source, destination):
    source, destination = os.path.abspath(source), os.path.abspath(destination)
    staging(source)
    if os.path.normcase(os.path.dirname(destination)) != os.path.normcase(mods):
        raise RuntimeError("Unexpected destination")
    if sys.platform == "win32":
        # os.rename on Windows never replaces an existing destination.
        os.rename(source, destination)
        return True
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename = library.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = rename(os.fsencode(source), os.fsencode(destination), 4) # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(library, "renameat2"):
        rename = library.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) # RENAME_NOREPLACE
    else:
        raise RuntimeError("Atomic no-clobber rename is unavailable on this platform")
    if result:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number), destination)
    return True

def run():
    if action == "kind":
        return kind(args[0])
    if action == "git":
        # Drop inherited Git overrides. Ignore global/system config, templates, hooks, credential
        # helpers, fsmonitor and global filters. Only HTTPS transport is permitted in production.
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
            GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="", SSH_ASKPASS="",
            GIT_ALLOW_PROTOCOL="https", GIT_ATTR_NOSYSTEM="1", GIT_LFS_SKIP_SMUDGE="1")
        command = shutil.which("git")
        if not command:
            raise RuntimeError("Git is not installed or is not on PATH")
        config = ["core.hooksPath=" + os.devnull, "core.fsmonitor=false",
            "core.attributesFile=" + os.devnull, "credential.helper=", "protocol.allow=never",
            "protocol.https.allow=always", "http.followRedirects=false", "maintenance.auto=false",
            "gc.auto=0", "core.protectHFS=true", "core.protectNTFS=true"]
        command_args = [command, "--no-optional-locks"]
        for setting in config:
            command_args.extend(["-c", setting])
        result = subprocess.run(command_args + args[1], cwd=args[0], env=environment,
            stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8", errors="strict", timeout=110)
        return {"code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
    check()
    if action == "check":
        return None
    if action == "list":
        return sorted(os.listdir(mods))
    if action == "acquire":
        os.makedirs(work, exist_ok=True)
        os.makedirs(mods, exist_ok=True)
        check()
        try:
            os.mkdir(lock)
        except FileExistsError:
            raise RuntimeError("Mod Manager is locked. Another operation may be running. See README recovery instructions.")
    elif action == "release":
        if kind(lock) != "directory":
            raise RuntimeError("Unsafe or missing operation lock")
        os.rmdir(lock)
    elif action == "stage":
        return tempfile.mkdtemp(prefix="install.", dir=work)
    elif action == "cleanup":
        staging(args[0])
        shutil.rmtree(args[0])
    elif action == "publish":
        try:
            return publish(args[0], args[1])
        except FileExistsError:
            return False
    else:
        raise RuntimeError("Unknown filesystem operation")
    return None

try:
    print(json.dumps({"ok": True, "value": run()}))
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)}))
    sys.exit(1)
`

/**
 * @param {{exec: Exec, read: (path: string) => Promise<string | null>, write: (path: string, text: string, expected: string | null) => Promise<unknown>, home: string}} host
 */
export function createRuntime(host) {
  // Git accepts forward slashes on Windows too; Python normalizes filesystem paths there.
  const root = host.home.replace(/\\/g, "/").replace(/\/+$/, "")
  const work = `${root}/data/mod-manager`

  /** @param {string} action @param {unknown[]} [args] */
  async function call(action, args = []) {
    let result
    try {
      result = await host.exec(
        "uv",
        [
          "run",
          "--no-project",
          "--offline",
          "--no-python-downloads",
          "python",
          "-I",
          "-S",
          "-c",
          HELPER,
          JSON.stringify({ root, action, args }),
        ],
        { cwd: root, timeout: 120_000 },
      )
    } catch (error) {
      throw new Error(`Local mod management requires Git, uv, and Python 3. ${String(error)}`)
    }
    let response
    try {
      response = JSON.parse(result.stdout)
    } catch {
      throw new Error(result.stderr.trim() || "Install uv and Python 3 before managing local mods.")
    }
    if (!response.ok || result.code !== 0) throw new Error(response.error || result.stderr.trim())
    return response.value
  }

  return {
    mods: `${root}/mods`,
    work,
    lock: `${work}/lock`,
    read: host.read,
    write: host.write,
    checkPaths: () => call("check"),
    /** @param {string} path @returns {Promise<string>} */
    kind: (path) => call("kind", [path]),
    /** @returns {Promise<string[]>} */
    list: () => call("list"),
    acquire: () => call("acquire"),
    release: () => call("release"),
    /** @returns {Promise<string>} */
    stage: async () => (await call("stage")).replace(/\\/g, "/"),
    /** @param {string} stage */
    cleanup: (stage) => call("cleanup", [stage]),
    /** @param {string} stage @param {string} destination @returns {Promise<boolean>} */
    publish: (stage, destination) => call("publish", [stage, destination]),
    /** @param {string} cwd @param {string[]} args @returns {Promise<ExecResult>} */
    git: (cwd, args) => call("git", [cwd, args]),
  }
}

/** @typedef {ReturnType<typeof createRuntime>} Runtime */
