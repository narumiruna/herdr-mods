"""Self-update tests use disposable Git checkouts and local transport only."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "self_update.py"
SPEC = importlib.util.spec_from_file_location("self_update", SCRIPT)
self_update = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(self_update)


class LocalUpdater(self_update.Updater):
    """Replace only transport and the external process boundary."""

    source = None
    active = False
    clone_calls = 0
    stopped_calls = 0
    on_clone = None
    on_stopped = None

    def _clone(self, destination):
        self.clone_calls += 1
        self._command([
            "-c", "protocol.file.allow=always", "clone", "--bare", "--no-local",
            "--no-tags", "--single-branch", "--branch", "main", "--template=",
            "--", str(self.source), str(destination),
        ], destination.parent)
        if self.on_clone is not None:
            self.on_clone(self)

    def _stopped(self):
        self.stopped_calls += 1
        if self.on_stopped is not None:
            self.on_stopped(self)
        self_update.require(not self.active, "Herdr is running (test process evidence)")


@unittest.skipUnless(sys.platform in {"darwin", "linux"} and shutil.which("git") and shutil.which("uv"), "macOS/Linux, Git, and uv required")
class SelfUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / "source"
        self.source.mkdir()
        self.env = {
            "PATH": os.environ.get("PATH", os.defpath), "HOME": "/nonexistent",
            "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
        }
        self.git(self.source, "init", "-b", "main")
        files = {
            "mod.json": '{"title":"Disposable manager"}\n',
            "main.js": "export default {version: 1};\n",
            "manager.js": "export default {};\n",
            "runtime.js": "export default {};\n",
            "operations.py": "# Disposable source\n",
            "self_update.py": SCRIPT.read_text(),
            ".gitignore": "*.ignored\nignored/\n",
            "obsolete.txt": "old file\n",
            "data/fixture.txt": "tracked data\n",
        }
        for name, text in files.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.installed = self.commit()
        (self.source / "main.js").write_text("export default {version: 2};\n")
        (self.source / "obsolete.txt").unlink()
        (self.source / "new.txt").write_text("new file\n")
        (self.source / "manager.js").chmod(0o755)
        self.target = self.commit()
        self.backend = type("FixtureUpdater", (LocalUpdater,), {"source": self.source})
        self.checkout_count = 0
        self.root, self.updater = self.checkout()

    def git(self, cwd, *args, input=None):
        result = subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
             "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *args],
            cwd=cwd, env=self.env, input=input, stdin=subprocess.DEVNULL if input is None else None,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30,
        )
        return result.stdout

    def commit(self):
        self.git(self.source, "add", "--", ".")
        self.git(self.source, "commit", "-m", "fixture")
        return self.git(self.source, "rev-parse", "HEAD").decode().strip()

    def checkout(self):
        self.checkout_count += 1
        root = self.base / ("checkout-" + str(self.checkout_count))
        # No candidate checkout: unsafe candidate trees must not reach the filesystem.
        self.git(self.base, "clone", "--no-local", "--no-checkout", "--template=", "--", str(self.source), str(root))
        self.git(root, "reset", "--hard", self.installed)
        self.git(root, "config", "remote.origin.url", self_update.SOURCE)
        return root, self.backend(root / "self_update.py")

    def apply(self, updater=None, **changes):
        updater = updater or self.updater
        fields = {"expected_path": str(updater.root), "installed": self.installed,
                  "target": self.target, "app_stopped": True}
        fields.update(changes)
        return updater.apply(**fields)

    def snapshot(self, root):
        result = {}
        for parent, dirs, files in os.walk(root, followlinks=False):
            for name in dirs + files:
                path = Path(parent) / name
                info = path.lstat()
                payload = os.readlink(path) if stat.S_ISLNK(info.st_mode) else path.read_bytes() if stat.S_ISREG(info.st_mode) else None
                result[str(path.relative_to(root))] = (
                    info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_mtime_ns, payload,
                )
        return result

    def head(self, root=None):
        return self.git(root or self.root, "rev-parse", "HEAD").decode().strip()

    def cli(self, args, updater=None):
        output = io.StringIO()
        factory = self.backend if updater is None else lambda script: updater
        with mock.patch.object(self_update, "Updater", factory), contextlib.redirect_stdout(output):
            code = self_update.main(args, script=(updater.root if updater else self.root) / "self_update.py")
        return code, json.loads(output.getvalue())

    def apply_args(self):
        return ["apply", "--expected-path", str(self.root), "--expected-commit", self.installed,
                "--target-commit", self.target, "--app-stopped"]

    def source_tree(self, changes):
        """Create candidate objects directly, including paths unsafe to check out."""
        entries = {}
        for entry in self.git(self.source, "ls-tree", "-r", "-z", self.target).split(b"\0"):
            if entry:
                header, path = entry.split(b"\t", 1)
                mode, kind, oid = header.decode().split()
                entries[path.decode()] = (mode, kind, oid)
        for name, value in changes.items():
            if value is None:
                entries.pop(name, None)
            else:
                mode, data = value
                if mode == "160000":
                    entries[name] = (mode, "commit", self.installed)
                else:
                    oid = self.git(self.source, "hash-object", "-w", "--stdin", input=data).decode().strip()
                    entries[name] = (mode, "blob", oid)
        nested = {}
        for path, entry in entries.items():
            folder = nested
            names = path.split("/")
            for name in names[:-1]:
                folder = folder.setdefault(name, {})
            folder[names[-1]] = entry

        def tree(folder):
            raw = b""
            for name, entry in sorted(folder.items()):
                if isinstance(entry, dict):
                    mode, kind, oid = "040000", "tree", tree(entry)
                else:
                    mode, kind, oid = entry
                raw += f"{mode} {kind} {oid}\t{name}".encode() + b"\0"
            return self.git(self.source, "mktree", "-z", input=raw).decode().strip()

        oid = self.git(self.source, "commit-tree", tree(nested), "-p", self.target, input=b"unsafe fixture\n").decode().strip()
        self.git(self.source, "update-ref", "refs/heads/main", oid)
        return oid

    def test_check_reports_exact_main_without_checkout_mutation(self):
        before = self.snapshot(self.root)
        source_before = self.snapshot(self.source)
        result = self.updater.check()
        self.assertEqual(result, {
            "ok": True, "path": str(self.root), "source": self_update.SOURCE,
            "branch": "main", "installedCommit": self.installed,
            "targetCommit": self.target, "updateAvailable": True,
        })
        self.assertEqual(self.snapshot(self.root), before)
        self.assertEqual(self.snapshot(self.source), source_before)
        self.assertEqual(self.updater.clone_calls, 1)
        self.assertEqual(self.updater.stopped_calls, 0)
        self.assertFalse((self.root / ".git" / self_update.LOCK).exists())

    def test_apply_fast_forwards_to_exact_main_and_verifies_files(self):
        (self.source / "not-main.txt").write_text("development only\n")
        development = self.commit()
        self.git(self.source, "branch", "development", development)
        self.git(self.source, "tag", "not-main", development)
        self.git(self.source, "update-ref", "refs/heads/main", self.target)
        source_before = self.snapshot(self.source)
        result = self.apply()
        self.assertEqual(result, {
            "ok": True, "path": str(self.root), "previousCommit": self.installed,
            "installedCommit": self.target, "restartRequired": True, "message": self_update.NOTICE,
        })
        self.assertEqual(self.head(), self.target)
        self.assertEqual(self.git(self.root, "symbolic-ref", "HEAD").strip(), b"refs/heads/main")
        self.assertEqual(self.git(self.root, "status", "--porcelain", "--ignored"), b"")
        self.assertEqual(self.git(self.root, "diff", "--exit-code", self.target, "--"), b"")
        self.assertEqual((self.root / "main.js").read_bytes(), (self.source / "main.js").read_bytes())
        self.assertTrue((self.root / "new.txt").is_file())
        self.assertFalse((self.root / "obsolete.txt").exists())
        self.assertFalse((self.root / "not-main.txt").exists())
        self.assertTrue((self.root / "manager.js").stat().st_mode & 0o111)
        self.assertFalse((self.root / ".git/FETCH_HEAD").exists())
        self.assertEqual(self.git(self.root, "config", "--get", "remote.origin.url").decode().strip(), self_update.SOURCE)
        self.assertEqual(self.snapshot(self.source), source_before)
        self.assertEqual(self.updater.stopped_calls, 2)

    def test_no_update_check_and_apply_keep_working_files(self):
        self.git(self.source, "update-ref", "refs/heads/main", self.installed)
        before = self.snapshot(self.root)
        result = self.updater.check()
        self.assertFalse(result["updateAvailable"])
        self.assertEqual(result["targetCommit"], self.installed)
        self.assertEqual(self.snapshot(self.root), before)
        result = self.apply(target=self.installed)
        self.assertTrue(result["ok"])
        self.assertFalse(result["restartRequired"])
        self.assertEqual(result["installedCommit"], self.installed)
        after = self.snapshot(self.root)
        self.assertEqual({k: v for k, v in after.items() if not k.startswith(".git")},
                         {k: v for k, v in before.items() if not k.startswith(".git")})

    def test_confirmation_validation_fails_before_transport(self):
        cases = [
            ({"app_stopped": False}, "--app-stopped"),
            ({"expected_path": str(self.root) + "/"}, "path changed"),
            ({"expected_path": str(self.base / "other")}, "path changed"),
            ({"installed": "A" * 40}, "lowercase"),
            ({"target": "f" * 39}, "40-character"),
            ({"installed": None}, "40-character"),
            ({"target": "main"}, "40-character"),
        ]
        for changes, message in cases:
            with self.subTest(changes=changes):
                before = self.snapshot(self.root)
                with self.assertRaisesRegex(self_update.UpdateError, message):
                    self.apply(**changes)
                self.assertEqual(self.snapshot(self.root), before)
        self.assertEqual(self.updater.clone_calls, 0)
        self.assertEqual(self.updater.stopped_calls, 0)

    def test_stale_installed_and_target_are_rejected(self):
        for changes, message in [({"installed": self.target}, "Installed commit changed"),
                                 ({"target": self.installed}, "Official main changed")]:
            with self.subTest(changes=changes):
                root, updater = self.checkout()
                with self.assertRaisesRegex(self_update.UpdateError, message):
                    self.apply(updater, **changes)
                self.assertEqual(self.head(root), self.installed)
                self.assertEqual((root / "main.js").read_text(), "export default {version: 1};\n")
                self.assertTrue((root / ".git" / self_update.LOCK).is_file())

    def test_main_moving_after_check_requires_new_confirmation(self):
        checked = self.updater.check()
        (self.source / "main.js").write_text("export default {version: 3};\n")
        newest = self.commit()
        self.assertNotEqual(newest, checked["targetCommit"])
        with self.assertRaisesRegex(self_update.UpdateError, "Official main changed"):
            self.apply()
        self.assertEqual(self.head(), self.installed)

    def test_production_process_parser_blocks_running_or_unknown_evidence(self):
        cases = [
            (b"1 /Applications/Herdr.app/Contents/MacOS/Herdr\n", 0, "Herdr is running"),
            (b"2 /usr/bin/herdr-app\n", 0, "Herdr is running"),
            (b"3 /opt/HERDR\n", 0, "Herdr is running"),
            (b"", 0, "empty"),
            (b"1\n", 0, "Malformed"),
            (b"unknown /usr/bin/ps\n", 0, "Malformed"),
            (b"1 /usr/bin/ps\0\n", 0, "Malformed"),
            (b"1 /usr/bin/ps\n", 1, "Cannot verify"),
        ]
        for output, code, message in cases:
            with self.subTest(output=output, code=code):
                response = subprocess.CompletedProcess([], code, stdout=output, stderr=b"unavailable")
                with mock.patch.object(self_update.subprocess, "run", return_value=response):
                    with self.assertRaisesRegex(self_update.UpdateError, message):
                        self_update.Updater._stopped(self.updater)
        response = subprocess.CompletedProcess([], 0, stdout=b"1 /usr/bin/launchd\n2 /usr/bin/herdr-core\n", stderr=b"")
        with mock.patch.object(self_update.subprocess, "run", return_value=response) as run:
            self_update.Updater._stopped(self.updater)
            self.assertEqual(run.call_args.args[0], ["ps", "-axo", "pid=,comm="])
            self.assertEqual(run.call_args.kwargs["timeout"], 10)
            self.assertIs(run.call_args.kwargs["stdin"], subprocess.DEVNULL)
        for error in [OSError("process inspection denied"), subprocess.TimeoutExpired("ps", 10)]:
            with self.subTest(error=str(error)):
                with mock.patch.object(self_update.subprocess, "run", side_effect=error):
                    with self.assertRaises(type(error)):
                        self_update.Updater._stopped(self.updater)
        response = subprocess.CompletedProcess([], 0, stdout=b"1 \xff\n", stderr=b"")
        with mock.patch.object(self_update.subprocess, "run", return_value=response):
            with self.assertRaises(UnicodeError):
                self_update.Updater._stopped(self.updater)

    def test_inherited_git_environment_cannot_select_repository_or_commands(self):
        marker = self.base / "inherited-command-executed"
        injected = {
            "GIT_DIR": str(self.source / ".git"), "GIT_WORK_TREE": str(self.source),
            "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.fsmonitor",
            "GIT_CONFIG_VALUE_0": "!touch " + str(marker),
            "GIT_CONFIG_GLOBAL": str(self.base / "untrusted-config"),
        }
        with mock.patch.dict(os.environ, injected):
            updater = self.backend(self.root / "self_update.py")
            checked = updater.check()
        self.assertEqual(checked["installedCommit"], self.installed)
        self.assertFalse(marker.exists())
        for key in injected.keys() - {"GIT_CONFIG_GLOBAL"}:
            self.assertNotIn(key, updater.env)
        self.assertEqual(updater.env["GIT_CONFIG_GLOBAL"], "/dev/null")

    def test_production_transport_is_fixed_https_main_without_test_configuration(self):
        destination = self.base / "private-source.git"
        with mock.patch.object(self.updater, "_command") as command:
            self_update.Updater._clone(self.updater, destination)
        args, cwd = command.call_args.args
        self.assertEqual(cwd, destination.parent)
        self.assertEqual(args[-2:], [self_update.SOURCE, str(destination)])
        self.assertEqual(args[args.index("--branch") + 1], "main")
        self.assertIn("--bare", args)
        self.assertIn("--no-local", args)
        self.assertIn("--single-branch", args)
        self.assertNotIn("protocol.file.allow=always", args)

    def test_development_link_reports_resolved_checkout_and_requires_exact_path(self):
        link = self.base / "development-link"
        link.symlink_to(self.root, target_is_directory=True)
        updater = self.backend(link / "self_update.py")
        checked = updater.check()
        self.assertEqual(checked["path"], str(self.root))
        with self.assertRaisesRegex(self_update.UpdateError, "path changed"):
            self.apply(updater, expected_path=str(link))
        self.assertTrue(self.apply(updater)["ok"])
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), self.root)
        self.assertEqual(self.head(), self.target)

    def test_active_process_blocks_before_lock_and_again_before_merge(self):
        self.updater.active = True
        before = self.snapshot(self.root)
        with self.assertRaisesRegex(self_update.UpdateError, "Herdr is running"):
            self.apply()
        self.assertEqual(self.snapshot(self.root), before)
        self.assertEqual(self.updater.clone_calls, 0)
        root, updater = self.checkout()

        def restart_at_second_check(instance):
            instance.active = instance.stopped_calls == 2

        updater.on_stopped = restart_at_second_check
        with self.assertRaisesRegex(self_update.UpdateError, "Herdr is running"):
            self.apply(updater)
        self.assertEqual(updater.stopped_calls, 2)
        self.assertEqual(self.head(root), self.installed)
        self.assertEqual((root / "main.js").read_text(), "export default {version: 1};\n")

    def test_wrong_origin_branch_and_detached_head_fail_without_transport(self):
        cases = [
            (("config", "remote.origin.url", "https://example.invalid/manager.git"), "origin"),
            (("checkout", "-b", "development"), "main branch"),
            (("checkout", "--detach"), "Git failed"),
        ]
        for args, message in cases:
            with self.subTest(args=args):
                root, updater = self.checkout()
                self.git(root, *args)
                before = self.snapshot(root)
                with self.assertRaisesRegex(self_update.UpdateError, message):
                    updater.check()
                self.assertEqual(self.snapshot(root), before)
                self.assertEqual(updater.clone_calls, 0)

    def test_dirty_staged_untracked_and_ignored_files_are_preserved(self):
        for kind in ["dirty", "staged", "untracked", "ignored-file", "ignored-directory"]:
            with self.subTest(kind=kind):
                root, updater = self.checkout()
                name = {"dirty": "main.js", "staged": "main.js", "untracked": "notes.txt",
                        "ignored-file": "local.ignored", "ignored-directory": "ignored/keep.txt"}[kind]
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("preserve local state\n")
                if kind == "staged":
                    self.git(root, "add", "--", name)
                before = self.snapshot(root)
                with self.assertRaisesRegex(self_update.UpdateError, "Local changes, untracked or ignored"):
                    updater.check()
                self.assertEqual(self.snapshot(root), before)
                self.assertEqual(updater.clone_calls, 0)

    def test_untracked_empty_directories_are_rejected_even_when_git_status_is_clean(self):
        for name in ["extra", "data/extra"]:
            with self.subTest(name=name):
                root, updater = self.checkout()
                (root / name).mkdir()
                self.assertEqual(self.git(root, "status", "--porcelain"), b"")
                before = self.snapshot(root)
                with self.assertRaisesRegex(self_update.UpdateError, "Unexpected or linked working directory"):
                    updater.check()
                self.assertEqual(self.snapshot(root), before)
                self.assertEqual(updater.clone_calls, 0)

    def test_hidden_index_flags_rejected_even_when_status_is_clean(self):
        for flag in ["--assume-unchanged", "--skip-worktree"]:
            for changed in [False, True]:
                with self.subTest(flag=flag, changed=changed):
                    root, updater = self.checkout()
                    self.git(root, "update-index", flag, "main.js")
                    if changed:
                        (root / "main.js").write_text("hidden local edit\n")
                    self.assertEqual(self.git(root, "status", "--porcelain"), b"")
                    before = self.snapshot(root)
                    with self.assertRaisesRegex(self_update.UpdateError, "Hidden index flags"):
                        updater.check()
                    self.assertEqual(self.snapshot(root), before)

    def test_unsafe_candidate_trees_are_rejected_without_checkout_writes(self):
        cases = [
            ({"link": ("120000", b"main.js")}, "symlinks and submodules"),
            ({"module": ("160000", b"")}, "symlinks and submodules"),
            ({"bad:name": ("100644", b"x")}, "Unsafe source path"),
            ({"bad\\name": ("100644", b"x")}, "Unsafe source path"),
            ({".GiT/config": ("100644", b"x")}, "Unsafe source path"),
            ({"data/.gitattributes": ("100644", b"* filter=evil")}, "attributes"),
            ({"data/.GITATTRIBUTES": ("100644", b"* filter=evil")}, "attributes"),
            ({"caf\u00e9": ("100644", b"x"), "cafe\u0301": ("100644", b"y")}, "only printable ASCII"),
            ({"caf\u00e9/x": ("100644", b"x"), "cafe\u0301/y": ("100644", b"y")}, "only printable ASCII"),
            ({"bad\tname": ("100644", b"x")}, "only printable ASCII"),
            ({"bad\nname": ("100644", b"x")}, "only printable ASCII"),
            ({"bad\x7fname": ("100644", b"x")}, "only printable ASCII"),
            ({"README": ("100644", b"x"), "readme": ("100644", b"y")}, "Case-conflicting"),
            ({"A/x": ("100644", b"x"), "a/y": ("100644", b"y")}, "Case-conflicting"),
            ({"runtime.js": None}, "Incomplete manager source"),
            ({"runtime.js": ("100644", b" \n")}, "Empty manager source"),
            ({"mod.json": ("100644", b"[]")}, "must be an object"),
        ]
        for changes, message in cases:
            with self.subTest(paths=list(changes)):
                self.source_tree(changes)
                before = self.snapshot(self.root)
                with self.assertRaisesRegex(self_update.UpdateError, message):
                    self.updater.check()
                self.assertEqual(self.snapshot(self.root), before)
                self.assertEqual(self.head(), self.installed)

    def test_non_fast_forward_candidate_is_rejected(self):
        tree = self.git(self.source, "rev-parse", self.target + "^{tree}").decode().strip()
        unrelated = self.git(self.source, "commit-tree", tree, input=b"unrelated root\n").decode().strip()
        self.git(self.source, "update-ref", "refs/heads/main", unrelated)
        before = self.snapshot(self.root)
        with self.assertRaisesRegex(self_update.UpdateError, "Git failed"):
            self.updater.check()
        self.assertEqual(self.snapshot(self.root), before)

    def test_malicious_local_configuration_fails_closed_without_execution(self):
        marker = self.base / "executed"
        command = "!touch " + str(marker)
        included = self.base / "included.config"
        included.write_text("[core]\n\tfsmonitor = " + command + "\n")
        cases = [
            ("filter.evil.clean", "touch " + str(marker)),
            ("filter.evil.smudge", "touch " + str(marker)),
            ("filter.evil.process", "touch " + str(marker)),
            ("include.path", str(included)),
            ("includeIf.gitdir:/.path", str(included)),
            ("url.ext::sh -c 'touch " + str(marker) + "'.insteadOf", "https://github.com/"),
            ("core.fsmonitor", command),
            ("core.sshCommand", "touch " + str(marker)),
            ("credential.helper", command),
            ("core.attributesFile", str(included)),
        ]
        for key, value in cases:
            with self.subTest(key=key):
                root, updater = self.checkout()
                self.git(root, "config", key, value)
                before = self.snapshot(root)
                with self.assertRaisesRegex(self_update.UpdateError, "Unsupported local Git setting"):
                    updater.check()
                self.assertFalse(marker.exists())
                self.assertEqual(self.snapshot(root), before)
                self.assertEqual(updater.clone_calls, 0)

    def test_local_attributes_fail_closed_before_filters_execute(self):
        marker = self.base / "filter-executed"
        (self.root / ".git/info").mkdir(exist_ok=True)
        (self.root / ".git/info/attributes").write_text("* filter=evil\n")
        self.git(self.root, "config", "filter.evil.clean", "touch " + str(marker))
        before = self.snapshot(self.root)
        with self.assertRaisesRegex(self_update.UpdateError, "Local Git attributes"):
            self.updater.check()
        self.assertEqual(self.snapshot(self.root), before)
        self.assertFalse(marker.exists())

    def test_repository_and_configured_hooks_never_execute(self):
        marker = self.base / "hook-executed"
        hooks = self.base / "external-hooks"
        hooks.mkdir()
        for folder in [hooks, self.root / ".git/hooks"]:
            folder.mkdir(exist_ok=True)
            for name in ["post-merge", "pre-merge-commit", "post-checkout", "reference-transaction", "pre-auto-gc"]:
                hook = folder / name
                hook.write_text("#!/bin/sh\ntouch '" + str(marker) + "'\nexit 1\n")
                hook.chmod(0o755)
        self.git(self.root, "config", "core.hooksPath", str(hooks))
        result = self.apply()
        self.assertTrue(result["ok"])
        self.assertEqual(self.head(), self.target)
        self.assertFalse(marker.exists())

    def test_git_metadata_symlinks_and_hardlinks_are_rejected(self):
        for kind in ["config-symlink", "head-symlink", "objects-symlink", "config-hardlink", "index-hardlink", "lock-hardlink"]:
            with self.subTest(kind=kind):
                root, updater = self.checkout()
                name = {"config-symlink": "config", "head-symlink": "HEAD", "objects-symlink": "objects",
                        "config-hardlink": "config", "index-hardlink": "index", "lock-hardlink": self_update.LOCK}[kind]
                path = root / ".git" / name
                outside = self.base / (kind + "-outside")
                if kind == "objects-symlink":
                    path.rename(outside)
                    path.symlink_to(outside, target_is_directory=True)
                elif kind.endswith("symlink"):
                    path.rename(outside)
                    path.symlink_to(outside)
                else:
                    if not path.exists():
                        path.write_bytes(b"lock sentinel")
                    os.link(path, outside)
                before = self.snapshot(root)
                with self.assertRaisesRegex(self_update.UpdateError, "Linked or unsafe Git metadata"):
                    updater.check()
                self.assertEqual(self.snapshot(root), before)
                self.assertEqual(updater.clone_calls, 0)

    def test_alternates_active_operations_and_other_unsupported_metadata(self):
        names = ["objects/info/alternates", "objects/info/http-alternates", "commondir", "gitdir",
                 "shallow", "config.worktree", "info/grafts", "refs/replace", "info/sparse-checkout",
                 "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer"]
        for name in names:
            with self.subTest(name=name):
                root, updater = self.checkout()
                path = root / ".git" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(str(self.source / ".git/objects"))
                before = self.snapshot(root)
                with self.assertRaisesRegex(self_update.UpdateError, "Unsupported or active Git metadata"):
                    updater.check()
                self.assertEqual(self.snapshot(root), before)
                self.assertEqual(updater.clone_calls, 0)

    def test_unreadable_metadata_walk_fails_closed(self):
        folder = self.root / ".git/unreadable"
        folder.mkdir()
        (folder / "sentinel").write_text("retain metadata\n")
        folder.chmod(0)
        try:
            if os.access(folder, os.R_OK):
                self.skipTest("Current user can read mode-000 directories")
            code, result = self.cli(["check"])
            self.assertEqual(code, 1)
            self.assertFalse(result["ok"])
            self.assertIn("Permission denied", result["error"])
            self.assertIn("unreadable", result["error"])
        finally:
            folder.chmod(0o700)
        self.assertEqual((folder / "sentinel").read_text(), "retain metadata\n")
        self.assertEqual(self.head(), self.installed)

    def test_linked_git_directory_and_working_files_are_rejected(self):
        for kind in ["git-symlink", "git-file", "file-hardlink", "file-symlink", "directory-symlink"]:
            with self.subTest(kind=kind):
                root, updater = self.checkout()
                if kind in {"git-symlink", "git-file"}:
                    gitdir = root / ".git"
                    outside = self.base / (kind + "-metadata")
                    gitdir.rename(outside)
                    if kind == "git-symlink":
                        gitdir.symlink_to(outside, target_is_directory=True)
                    else:
                        gitdir.write_text("gitdir: " + str(outside) + "\n")
                    with self.assertRaisesRegex(self_update.UpdateError, "Real directory required"):
                        self.backend(root / "self_update.py")
                else:
                    path = root / ("data" if kind == "directory-symlink" else "main.js")
                    outside = self.base / (kind + "-working")
                    if kind == "file-hardlink":
                        os.link(path, outside)
                    else:
                        path.rename(outside)
                        path.symlink_to(outside, target_is_directory=kind == "directory-symlink")
                    before = self.snapshot(root)
                    with self.assertRaises(self_update.UpdateError):
                        updater.check()
                    self.assertEqual(self.snapshot(root), before)

    def test_busy_lock_has_stable_inode_and_can_be_reused_after_release(self):
        import fcntl

        lock = self.root / ".git" / self_update.LOCK
        with lock.open("w+b") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            identity = self_update.stamp(lock)
            for _ in range(2):
                with self.assertRaisesRegex(self_update.UpdateError, "Another self-update"):
                    self.apply()
                self.assertEqual(self_update.stamp(lock), identity)
                self.assertEqual(self.head(), self.installed)
            self.assertEqual(self.updater.clone_calls, 0)
            fcntl.flock(handle, fcntl.LOCK_UN)
        self.assertTrue(self.apply()["ok"])
        self.assertEqual(self_update.stamp(lock), identity)
        self.assertTrue(self.apply(installed=self.target)["ok"])
        self.assertEqual(self_update.stamp(lock), identity)

    def test_changed_lifecycle_lock_is_rejected_before_merge(self):
        for kind in ["replace", "symlink", "hardlink"]:
            with self.subTest(kind=kind):
                root, updater = self.checkout()
                lock = root / ".git" / self_update.LOCK
                outside = self.base / ("preserved-lock-" + kind)

                def change_lock(instance):
                    if instance.stopped_calls != 2:
                        return
                    if kind == "hardlink":
                        os.link(lock, outside)
                    else:
                        lock.rename(outside)
                        if kind == "symlink":
                            lock.symlink_to(outside)
                        else:
                            lock.write_text("replacement lock\n")

                updater.on_stopped = change_lock
                with self.assertRaisesRegex(self_update.UpdateError, "Self-update lock identity changed"):
                    self.apply(updater)
                self.assertEqual(self.head(root), self.installed)
                self.assertEqual((root / "main.js").read_text(), "export default {version: 1};\n")
                self.assertTrue(outside.is_file())
                self.assertTrue(lock.exists())

    def test_existing_ref_lock_failure_preserves_every_file(self):
        lock = self.root / ".git/refs/heads/main.lock"
        lock.write_text("other writer state\n")
        before = self.snapshot(self.root)
        code, result = self.cli(self.apply_args())
        self.assertEqual(code, 1)
        self.assertFalse(result["ok"])
        self.assertIn("Active Git lock", result["error"])
        self.assertEqual(result["recovery"], self_update.RECOVERY)
        self.assertEqual(self.snapshot(self.root), before)

    def test_ref_lock_during_merge_returns_no_success_and_does_not_reset(self):
        lock = self.root / ".git/refs/heads/main.lock"

        def lock_before_merge(instance):
            if instance.stopped_calls == 2:
                lock.write_text("preserve concurrent writer\n")

        self.updater.on_stopped = lock_before_merge
        code, result = self.cli(self.apply_args(), self.updater)
        self.assertEqual(code, 1)
        self.assertFalse(result["ok"])
        self.assertIn("Git failed", result["error"])
        self.assertEqual(result["previousCommit"], self.installed)
        self.assertEqual(result["targetCommit"], self.target)
        self.assertEqual(result["recovery"], self_update.RECOVERY)
        self.assertNotIn("restartRequired", result)
        self.assertNotIn("message", result)
        self.assertEqual(self.head(), self.installed)
        self.assertEqual(lock.read_text(), "preserve concurrent writer\n")
        self.assertTrue((self.root / ".git" / self_update.LOCK).is_file())
        self.assertEqual(result["currentCommit"], self.installed)
        self.assertIn("M  main.js", result["workingState"])
        self.assertEqual((self.root / "main.js").read_text(), "export default {version: 2};\n")
        self.assertEqual(self.git(self.root, "diff", "--cached", "--name-only").decode().splitlines(),
                         ["main.js", "manager.js", "new.txt", "obsolete.txt"])
        after = self.snapshot(self.root)
        self.updater.failure_state()
        self.assertEqual(self.snapshot(self.root), after)

    def test_transport_failure_keeps_checkout_and_reports_recovery_state(self):
        self.updater.source = self.base / "missing-source"
        before = (self.root / "main.js").read_bytes()
        code, result = self.cli(self.apply_args(), self.updater)
        self.assertEqual(code, 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["currentCommit"], self.installed)
        self.assertEqual(result["workingState"], "")
        self.assertEqual(result["recovery"], self_update.RECOVERY)
        self.assertEqual((self.root / "main.js").read_bytes(), before)
        self.assertEqual(self.head(), self.installed)
        self.assertTrue((self.root / ".git" / self_update.LOCK).is_file())

    def test_check_detects_checkout_changes_during_candidate_download(self):
        def change_installation(instance):
            (instance.root / "main.js").write_text("concurrent local change\n")

        self.updater.on_clone = change_installation
        with self.assertRaisesRegex(self_update.UpdateError, "Local changes"):
            self.updater.check()
        self.assertEqual((self.root / "main.js").read_text(), "concurrent local change\n")
        self.assertEqual(self.head(), self.installed)

    def test_cli_success_uses_json_and_zero_exit_status(self):
        code, checked = self.cli(["check"])
        self.assertEqual(code, 0)
        self.assertTrue(checked["ok"])
        self.assertEqual(checked["targetCommit"], self.target)
        code, applied = self.cli(self.apply_args())
        self.assertEqual(code, 0)
        self.assertTrue(applied["ok"])
        self.assertEqual(applied["installedCommit"], self.target)

    def test_cli_help_argument_errors_and_json_failure_exit_codes(self):
        # Real CLI subprocesses cannot reach transport: help exits at parsing,
        # and check rejects this deliberately invalid origin before cloning.
        self.git(self.root, "config", "remote.origin.url", "https://example.invalid/not-official.git")
        before = self.snapshot(self.root)
        for args in [["--help"], ["apply", "--help"], ["apply"], ["check"]]:
            with self.subTest(args=args):
                result = subprocess.run(
                    ["uv", "run", "--no-project", "--offline", "--no-python-downloads",
                     "python", "-I", "-S", str(self.root / "self_update.py"), *args],
                    cwd=self.base,
                    env={**self.env, "UV_PYTHON": sys.executable, "UV_CACHE_DIR": str(self.base / "uv-cache")},
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    check=False, timeout=30,
                )
                if "--help" in args:
                    self.assertEqual(result.returncode, 0)
                    self.assertIn(b"usage:", result.stdout)
                    if args[0] == "apply":
                        self.assertIn(b"--app-stopped", result.stdout)
                elif args == ["apply"]:
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(b"required", result.stderr)
                else:
                    self.assertEqual(result.returncode, 1)
                    error = json.loads(result.stdout)
                    self.assertFalse(error["ok"])
                    self.assertIn("origin", error["error"])
                    self.assertEqual(error["recovery"], self_update.RECOVERY)
                self.assertEqual(self.snapshot(self.root), before)


if __name__ == "__main__":
    unittest.main()
