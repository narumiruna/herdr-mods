"""Lifecycle tests use disposable profiles and local git, never installed mods."""

import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("operations", Path(__file__).resolve().parents[1] / "operations.py")
operations = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operations)


class LocalOperations(operations.Operations):
    source = None

    def run(self, request):
        # Legacy fixture callers get the real two-call protocol. This adapter is
        # test-only; the production backend always rejects an unstaged update.
        if isinstance(request, dict) and request.get("action") == "update" and "stageToken" not in request:
            prepared = super().run({**request, "action": "prepare-update"})
            if not prepared["ok"]:
                return prepared
            return type(self)(self.home).run({**request, "stageToken": prepared["stageToken"], "targetCommit": request.get("targetCommit", prepared["commit"])})
        return super().run(request)

    def _clone(self, repository, workspace_fd):
        # The sole injected transport boundary. Production has no file:// option.
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "clone", "--no-checkout", "--no-hardlinks", "--template=", "--", str(self.source), "repository"],
            preexec_fn=lambda: os.fchdir(workspace_fd), pass_fds=(workspace_fd,),
            env={"PATH": os.environ["PATH"], "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30,
        )


@unittest.skipUnless(os.name == "posix" and shutil.which("git"), "POSIX and local git required")
class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / "app"
        self.home.mkdir()
        (self.home / "mods").mkdir()
        (self.home / "installed.json").write_text("{}")
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.write_mod()
        self.commit()
        self.backend = type("FixtureOperations", (LocalOperations,), {"source": self.repo})

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        result = subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *args], cwd=self.repo,
            env={"PATH": os.environ["PATH"], "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30,
        )
        return result.stdout.decode().strip()

    def write_mod(self, prefix="", text="export default {};\n", **manifest):
        folder = self.repo / prefix
        folder.mkdir(parents=True, exist_ok=True)
        value = {"title": "Fixture", "description": "Temporary mod", "version": "1.0", "place": "none", **manifest}
        (folder / "mod.json").write_text(json.dumps(value))
        (folder / "main.js").write_text(text)

    def commit(self):
        self.git("add", "--", ".")
        self.git("commit", "-m", "fixture")
        return self.git("rev-parse", "HEAD")

    def run_request(self, action, backend=None, **fields):
        return (backend or self.backend)(str(self.home)).run({"action": action, **fields})

    def good(self, result):
        self.assertTrue(result["ok"], result)
        return result

    def bad(self, result, text=None):
        self.assertFalse(result["ok"], result)
        if text:
            self.assertIn(text.lower(), result["error"].lower(), result)
        return result

    def install(self, **fields):
        return self.good(self.run_request("install", repository="Example/Fixture", **fields))

    def discover(self, **fields):
        return self.good(self.run_request("discover", **fields))

    def confirmation(self, name="fixture"):
        mod = next(m for m in self.discover(runtimeKnown=True)["mods"] if m["id"] == name)
        return {"id": name, "expectedCommit": mod["commit"], "identityToken": mod["identityToken"], "path": mod["path"], "runtimeKnown": True, "dependencies": []}

    @property
    def state(self):
        return self.home / "data" / "mod-manager"

    def test_shipped_source_overrides_earlier_runtime_reference(self):
        folder = self.home / "mods" / "builtin"
        folder.mkdir()
        (folder / "mod.json").write_text('{"place":"none"}')
        (folder / "main.js").write_text("export default {};")
        (self.home / "installed.json").write_text('{"builtin":{}}')
        result = self.discover(runtimeKnown=True, dependencies=["builtin"])
        entry = next(mod for mod in result["mods"] if mod["id"] == "builtin")
        self.assertEqual(entry["source"], "shipped")
        self.assertIn("Shipped", entry["protectedReason"])

    def test_full_lifecycle_and_reopen(self):
        installed = self.install()
        first = installed["mods"][0]
        self.assertEqual(installed["ids"], ["fixture"])
        self.assertEqual(installed["commit"], first["commit"])
        self.assertTrue(first["managed"])
        self.assertEqual(first["repository"], "example/fixture")
        self.assertEqual(first["recipePath"], "")
        self.assertEqual(first["source"], "github")
        self.assertNotIn("enabled", first)
        self.assertEqual(self.discover()["mods"][0]["commit"], first["commit"])
        current = self.good(self.run_request("check-update", id="fixture"))
        self.assertIsNone(current["updateCommit"])
        (self.repo / "main.js").write_text("export default {version: 2};\n")
        new_commit = self.commit()
        available = self.good(self.run_request("check-update", id="fixture"))
        self.assertEqual(available["updateCommit"], new_commit)
        self.assertEqual(available["mods"][0]["updateCommit"], new_commit)
        before_inode = (self.home / "mods/fixture").stat().st_ino
        self.good(self.run_request("update", **self.confirmation()))
        self.assertEqual((self.home / "mods/fixture").stat().st_ino, before_inode)
        self.assertEqual(self.discover()["mods"][0]["commit"], new_commit)
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "export default {version: 2};\n")
        removed = self.good(self.run_request("uninstall", **self.confirmation()))
        self.assertEqual(removed["mods"], [])
        self.assertIn("does not prove", removed["notice"])
        registry = json.loads((self.state / "registry.json").read_text())
        self.assertEqual(registry["mods"], {})
        self.assertEqual(registry["history"][0]["repository"], "example/fixture")
        self.install()

    def test_discovery_is_read_only_and_lists_broken_unmanaged(self):
        unmanaged = self.home / "mods/local"
        unmanaged.mkdir()
        (unmanaged / "mod.json").write_text("{broken")
        result = self.discover()
        self.assertFalse((self.home / "data").exists())
        self.assertEqual(result["mods"][0]["id"], "local")
        self.assertFalse(result["mods"][0]["managed"])
        self.assertIn("Broken", result["mods"][0]["protectedReason"])

    def test_symlink_discovery_never_reads_target(self):
        (self.home / "mods/development").symlink_to(self.repo, target_is_directory=True)
        mod = self.discover()["mods"][0]
        self.assertEqual(mod["source"], "development")
        self.assertEqual(mod["name"], "development")
        self.assertIn("Symbolic-link", mod["protectedReason"])
        self.bad(self.run_request("uninstall", id="development", runtimeKnown=True), "confirmation")

    def test_bundle_case_sensitive_selection(self):
        (self.repo / "mod.json").unlink()
        (self.repo / "main.js").unlink()
        self.write_mod("Recipe/mods/alpha")
        self.write_mod("Recipe/mods/beta")
        self.commit()
        self.bad(self.run_request("install", repository="example/fixture", recipePath="recipe", modNames=["alpha"]), "recipePath")
        self.bad(self.run_request("install", repository="example/fixture", recipePath="Recipe"), "explicit modNames")
        result = self.install(recipePath="Recipe", modNames=["alpha", "beta"])
        self.assertEqual([m["id"] for m in result["mods"]], ["alpha", "beta"])
        self.assertTrue(all(m["recipePath"] == "Recipe" for m in result["mods"]))
        self.good(self.run_request("uninstall", **self.confirmation("alpha")))
        self.assertTrue((self.home / "mods/beta/main.js").exists())

    def test_bundle_root_ambiguity(self):
        self.write_mod("mods/alpha")
        self.commit()
        self.bad(self.run_request("install", repository="example/fixture", modNames=["alpha"]), "Ambiguous")
        self.assertEqual(list((self.home / "mods").iterdir()), [])

    def test_root_explicit_folder_and_duplicate_source(self):
        self.install(modNames=["selected"])
        self.bad(self.run_request("install", repository="example/fixture", modNames=["other"]), "identity")
        self.assertFalse((self.home / "mods/other").exists())

    def test_existing_destination_never_overwritten(self):
        destination = self.home / "mods/fixture"
        destination.mkdir()
        (destination / "sentinel").write_text("keep")
        self.bad(self.run_request("install", repository="example/fixture"), "exists")
        self.assertEqual((destination / "sentinel").read_text(), "keep")
        self.assertFalse((destination / "main.js").exists())

    def test_case_conflicting_destination_rejected(self):
        (self.home / "mods/Fixture").mkdir()
        self.bad(self.run_request("install", repository="example/fixture"), "exists")

    def test_input_validation(self):
        invalid = [
            None, [], {"action": "shell"}, {"action": "discover", "dependencies": "fixture"},
            {"action": "discover", "runtimeKnown": 1}, {"action": "discover", "unknown": True},
            {"action": "install", "repository": "file:///tmp/repo"},
            {"action": "install", "repository": "https://github.com/a/b"},
            {"action": "install", "repository": "a/b.git"},
            {"action": "install", "repository": "a/b;touch bad"},
            {"action": "install", "repository": "a/b", "recipePath": "../outside"},
            {"action": "install", "repository": "a/b", "recipePath": "/absolute"},
            {"action": "install", "repository": "a/b", "recipePath": ".git"},
            {"action": "install", "repository": "a/b", "modNames": ["../bad"]},
            {"action": "install", "repository": "a/b", "modNames": ["a", "A"]},
            {"action": "update", "id": "../fixture"},
            {"action": "check-update", "id": "fixture", "expectedCommit": "HEAD"},
        ]
        for request in invalid:
            with self.subTest(request=request):
                self.bad(self.backend(str(self.home)).run(request))

    def test_expected_install_commit(self):
        self.bad(self.run_request("install", repository="example/fixture", expectedCommit="0" * 40), "expectedCommit")
        self.assertFalse((self.home / "mods/fixture").exists())
        self.install(expectedCommit=self.git("rev-parse", "HEAD"))

    def test_manifest_static_validation_no_execution(self):
        marker = self.base / "executed"
        self.write_mod(text=f"require('fs').writeFileSync({json.dumps(str(marker))}, 'bad');")
        self.commit()
        self.install()
        self.assertFalse(marker.exists())

    def test_invalid_manifests_and_entries(self):
        cases = [
            ({"place": "left"}, "x", "placement"),
            ({"place": None}, "x", "placement"),
            ({"scripts": {"install": "bad"}}, "x", "Dangerous"),
            ({"title": 5}, "x", "title"),
            ({}, "  \n", "nonempty"),
            ({}, "\x00", "nonempty"),
        ]
        for manifest, text, message in cases:
            with self.subTest(manifest=manifest, text=text):
                self.write_mod(text=text, **manifest)
                self.commit()
                self.bad(self.run_request("install", repository="example/fixture"), message)
                self.assertFalse((self.home / "mods/fixture").exists())
        (self.repo / "mod.json").write_text("[]")
        self.commit()
        self.bad(self.run_request("install", repository="example/fixture"), "object")

    def test_symlink_tree_rejected(self):
        (self.repo / "linked").symlink_to("main.js")
        self.commit()
        self.bad(self.run_request("install", repository="example/fixture"), "symlink")

    def test_gitlink_tree_rejected(self):
        commit = self.git("rev-parse", "HEAD")
        self.git("update-index", "--add", "--cacheinfo", f"160000,{commit},nested")
        self.git("commit", "-m", "gitlink fixture")
        self.bad(self.run_request("install", repository="example/fixture"), "gitlinks")

    def test_unsafe_tree_path_rejected(self):
        (self.repo / "bad\\name").write_text("bad")
        self.commit()
        self.bad(self.run_request("install", repository="example/fixture"), "Unsafe")

    def test_executable_regular_file_supported(self):
        helper = self.repo / "helper.sh"
        helper.write_text("#!/bin/sh\nexit 99\n")
        helper.chmod(0o755)
        self.commit()
        self.install()
        self.assertEqual((self.home / "mods/fixture/helper.sh").stat().st_mode & 0o777, 0o755)

    def test_runtime_and_confirmation_required(self):
        self.install()
        confirmation = self.confirmation()
        unknown = {**confirmation, "runtimeKnown": False}
        self.bad(self.run_request("update", **unknown), "unknown")
        self.bad(self.run_request("uninstall", **unknown), "unknown")
        self.bad(self.run_request("uninstall", id="fixture", runtimeKnown=True), "confirmation")
        self.bad(self.run_request("uninstall", **{**confirmation, "path": "/wrong"}), "path")
        self.bad(self.run_request("uninstall", **{**confirmation, "expectedCommit": "0" * 40}), "commit")
        self.bad(self.run_request("uninstall", **{**confirmation, "identityToken": "0" * 32}), "identity")
        self.assertTrue((self.home / "mods/fixture/main.js").exists())

    def test_stale_handler_after_same_revision_reinstall(self):
        self.install()
        confirmation = self.confirmation()
        self.good(self.run_request("uninstall", **confirmation))
        self.install()
        self.bad(self.run_request("uninstall", **confirmation), "identity")

    def test_source_mismatch(self):
        self.install()
        self.bad(self.run_request("update", **self.confirmation(), repository="other/repo"), "source mismatch")
        self.bad(self.run_request("update", **self.confirmation(), recipePath="Other"), "source mismatch")

    def test_local_edits_untracked_hardlinks_and_target_swap(self):
        self.install()
        confirmation = self.confirmation()
        target = self.home / "mods/fixture"
        (target / "main.js").write_text("local edit")
        self.bad(self.run_request("uninstall", **confirmation), "Local changes")
        (target / "main.js").write_text((self.repo / "main.js").read_text())
        (target / "notes.txt").write_text("keep")
        self.bad(self.run_request("uninstall", **confirmation), "Untracked")
        (target / "notes.txt").unlink()
        os.link(target / "main.js", self.base / "hardlink")
        self.bad(self.run_request("uninstall", **confirmation), "linked")
        (self.base / "hardlink").unlink()
        target.rename(self.home / "mods/original")
        shutil.copytree(self.home / "mods/original", target)
        self.bad(self.run_request("uninstall", **confirmation), "identity")
        self.assertTrue((self.home / "mods/original/main.js").exists())

    def test_generated_looking_names_do_not_authorize_unknown_user_files(self):
        self.install()
        target = self.home / "mods/fixture"
        before = (target / "main.js").read_bytes()
        (target / "gpui-kit.d.ts").write_text("// user annotations")
        (target / "jsconfig.json").write_text('{"user":"keep"}')
        (self.repo / "main.js").write_text("export default {v:2};")
        self.commit()
        self.bad(self.run_request("update", **self.confirmation()), "Untracked local file")
        self.bad(self.run_request("uninstall", **self.confirmation()), "Untracked local file")
        self.assertEqual((target / "main.js").read_bytes(), before)
        self.assertEqual((target / "gpui-kit.d.ts").read_text(), "// user annotations")
        self.assertEqual((target / "jsconfig.json").read_text(), '{"user":"keep"}')

    def test_baseline_host_file_is_not_exempt(self):
        (self.repo / "jsconfig.json").write_text("{}")
        self.commit()
        self.install()
        (self.home / "mods/fixture/jsconfig.json").write_text('{"changed":true}')
        self.bad(self.run_request("update", **self.confirmation()), "Local changes")

    def test_protected_runtime_layout_keys_and_shipped(self):
        self.install()
        confirmation = self.confirmation()
        self.bad(self.run_request("uninstall", **{**confirmation, "dependencies": ["fixture"]}), "runtime dependency")
        layouts = self.home / "layouts"
        layouts.mkdir()
        layout = layouts / "inactive.json"
        layout.write_text(json.dumps({"slots": [{"mod": "fixture"}]}))
        self.bad(self.run_request("uninstall", **confirmation), "layout")
        layout.unlink()
        keys = self.home / "keys.json"
        keys.write_text(json.dumps({"x": {"command": "mod.open", "args": {"id": "fixture"}}}))
        self.bad(self.run_request("uninstall", **confirmation), "key")
        keys.unlink()
        installed = self.home / "installed.json"
        installed.write_text(json.dumps({"fixture": {"main.js": "fingerprint"}}))
        self.bad(self.run_request("uninstall", **confirmation), "Shipped")
        self.assertEqual(self.discover()["mods"][0]["source"], "shipped")
        installed.write_text("{}")
        self.good(self.run_request("uninstall", **confirmation))

    def test_metadata_assets_ignored_and_missing_shipped_metadata_blocks(self):
        layouts = self.home / "layouts"
        layouts.mkdir()
        (layouts / "win98.svg").write_text("<svg/>")
        self.install()
        confirmation = self.confirmation()
        (self.home / "installed.json").unlink()
        self.bad(self.run_request("uninstall", **confirmation), "Missing installed.json")
        self.bad(self.run_request("install", repository="other/repo"), "Missing installed.json")
        self.assertTrue(self.discover()["warnings"])

    def test_manager_id_always_protected(self):
        self.bad(self.run_request("install", repository="example/fixture", modNames=["mod-manager"]), "manager")

    def test_malformed_metadata_and_symlink_metadata_block(self):
        self.install()
        confirmation = self.confirmation()
        layouts = self.home / "layouts"
        layouts.mkdir()
        bad = layouts / "broken.json"
        bad.write_text("{")
        self.bad(self.run_request("update", **confirmation), "dependency safety")
        self.assertTrue(self.discover()["warnings"])
        bad.unlink()
        bad.symlink_to(self.repo / "mod.json")
        self.bad(self.run_request("uninstall", **confirmation), "dependency safety")

    def test_symlink_mods_and_ancestors_block(self):
        (self.home / "mods").rmdir()
        outside = self.base / "outside"
        outside.mkdir()
        (self.home / "mods").symlink_to(outside, target_is_directory=True)
        self.bad(self.run_request("install", repository="example/fixture"))
        self.assertEqual(list(outside.iterdir()), [])
        alias = self.base / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(OSError):
            self.backend(str(alias))

    def test_ancestor_swap_during_fetch_blocked(self):
        home = self.home
        outside = self.base / "outside"
        outside.mkdir()
        class Swap(self.backend):
            def _clone(inner, repository, workspace_fd):
                super()._clone(repository, workspace_fd)
                home.rename(home.with_name("old-app"))
                home.symlink_to(outside, target_is_directory=True)
        self.bad(self.run_request("install", backend=Swap, repository="example/fixture"), "swap")
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((self.base / "old-app/mods/fixture").exists())

    def test_non_fast_forward_rejected(self):
        self.install()
        first = self.git("rev-parse", "HEAD")
        self.git("checkout", "--orphan", "rewritten")
        self.write_mod(text="export default {rewrite:true};")
        self.commit()
        self.bad(self.run_request("check-update", id="fixture"), "fast-forward")
        self.bad(self.run_request("update", **self.confirmation()), "fast-forward")
        self.assertEqual(self.discover()["mods"][0]["commit"], first)

    def test_invalid_update_tree_leaves_previous_revision(self):
        self.install()
        previous = (self.home / "mods/fixture/main.js").read_bytes()
        self.write_mod(place="left")
        self.commit()
        self.bad(self.run_request("update", **self.confirmation()), "placement")
        self.assertEqual((self.home / "mods/fixture/main.js").read_bytes(), previous)

    def test_update_removes_obsolete_files_keeps_live_directory(self):
        old = self.repo / "old/nested.txt"
        old.parent.mkdir()
        old.write_text("old")
        self.commit()
        self.install()
        old.unlink()
        old.parent.rmdir()
        (self.repo / "new").mkdir()
        (self.repo / "new/added.txt").write_text("new")
        self.commit()
        self.good(self.run_request("update", **self.confirmation()))
        self.assertFalse((self.home / "mods/fixture/old").exists())
        self.assertEqual((self.home / "mods/fixture/new/added.txt").read_text(), "new")

    def test_missing_git_has_visible_error(self):
        with mock.patch.object(operations.shutil, "which", return_value=None):
            self.bad(self.run_request("install", repository="example/fixture", backend=operations.Operations), "git is unavailable")
        self.assertFalse((self.home / "mods/fixture").exists())

    def test_git_environment_is_scrubbed_and_only_https(self):
        backend = operations.Operations(str(self.home))
        fake = subprocess.CompletedProcess([], 0, b"ok", b"")
        try:
            with mock.patch.dict(os.environ, {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.sshCommand", "GIT_CONFIG_VALUE_0": "malicious", "GIT_SSH_COMMAND": "bad"}), mock.patch.object(operations.subprocess, "run", return_value=fake) as run:
                backend._clone("Example/Fixture", backend.fs.root)
            args, kwargs = run.call_args
            self.assertIn("https://github.com/example/fixture.git", args[0])
            self.assertIn("--no-checkout", args[0])
            self.assertNotIn("GIT_CONFIG_COUNT", kwargs["env"])
            self.assertNotIn("GIT_SSH_COMMAND", kwargs["env"])
            self.assertEqual(kwargs["env"]["GIT_ALLOW_PROTOCOL"], "https")
            self.assertEqual(kwargs["env"]["GIT_CONFIG_GLOBAL"], "/dev/null")
            self.assertIn("core.hooksPath=/dev/null", args[0])
        finally:
            backend.close()

    def test_corrupt_missing_registry_never_resets_ownership(self):
        self.install()
        registry = self.state / "registry.json"
        original = registry.read_text()
        for corrupt in ("{", "{}", '{"version":1,"mods":{},"history":{},"extra":true}'):
            registry.write_text(corrupt)
            self.bad(self.run_request("install", repository="other/repo"))
            self.assertTrue(self.discover()["warnings"])
        registry.write_text(original)
        registry.unlink()
        self.bad(self.run_request("install", repository="other/repo"), "Missing registry")

    def test_corrupt_lock_and_busy_lock(self):
        self.install()
        lock = self.state / "lock"
        lock.write_text("bad")
        self.bad(self.run_request("install", repository="other/repo"), "lock")
        self.assertTrue(self.discover()["warnings"])
        lock.write_text('{"version":1}\n')
        with lock.open("rb") as held:
            operations.fcntl.flock(held.fileno(), operations.fcntl.LOCK_EX | operations.fcntl.LOCK_NB)
            self.bad(self.run_request("install", repository="other/repo"), "Another lifecycle")
            discovered = self.discover(runtimeKnown=True)
            self.assertTrue(discovered["warnings"])
            self.assertIn("transaction", discovered["mods"][0]["protectedReason"])
        # A stale lock file has no live flock; it does not need deletion.
        self.good(self.run_request("check-update", id="fixture"))

    def test_stale_transaction_blocks_writes_and_marks_discovery(self):
        self.install()
        (self.state / "transaction.json").write_text('{"action":"update","workspace":"work-interrupted"}')
        self.bad(self.run_request("uninstall", **self.confirmation()), "Interrupted transaction")
        self.bad(self.run_request("install", repository="other/repo"), "workspace backups")
        self.assertTrue(self.discover()["warnings"])
        (self.state / "transaction.json").write_text("corrupt")
        self.bad(self.run_request("install", repository="other/repo"), "Interrupted transaction")

    def test_multi_install_rollback_and_main_last(self):
        (self.repo / "mod.json").unlink()
        (self.repo / "main.js").unlink()
        self.write_mod("Recipe/mods/alpha")
        self.write_mod("Recipe/mods/beta")
        self.commit()
        written = []
        state = self.state
        class Failure(self.backend):
            def _write_live(inner, name, inode, path, *args, **kwargs):
                self.assertTrue((state / "transaction.json").exists())
                if name == "beta":
                    raise OSError("fixture write failed")
                super()._write_live(name, inode, path, *args, **kwargs)
                written.append(path)
        self.bad(self.run_request("install", backend=Failure, repository="example/fixture", recipePath="Recipe", modNames=["alpha", "beta"]), "fixture write failed")
        self.assertEqual(list((self.home / "mods").iterdir()), [])
        self.assertEqual(written[-1], "main.js")
        self.assertFalse((self.state / "transaction.json").exists())
        self.assertEqual(json.loads((self.state / "registry.json").read_text())["mods"], {})

    def test_partial_file_write_rolls_back_created_paths(self):
        class Partial(self.backend):
            def _write_live(inner, *args, **kwargs):
                def fail_write(fd, data):
                    os.write(fd, data[:3])
                    raise OSError("fixture partial write")
                with mock.patch.object(inner.fs, "write_fd", side_effect=fail_write):
                    super()._write_live(*args, **kwargs)
        self.bad(self.run_request("install", backend=Partial, repository="example/fixture"), "fixture partial write")
        self.assertEqual(list((self.home / "mods").iterdir()), [])
        self.assertFalse((self.state / "transaction.json").exists())

    def test_destination_creation_race_never_overwrites(self):
        target = self.home / "mods/fixture"
        class Race(self.backend):
            def _mkdir_live(inner, name):
                target.mkdir()
                (target / "sentinel").write_text("keep")
                return super()._mkdir_live(name)
        self.bad(self.run_request("install", backend=Race, repository="example/fixture"), "exists")
        self.assertEqual((target / "sentinel").read_text(), "keep")
        self.assertFalse((target / "main.js").exists())

    def test_nested_real_directory_swap_blocks_new_file_write(self):
        nested = self.repo / "nested"
        nested.mkdir()
        (nested / "a.txt").write_text("old")
        self.commit()
        self.install()
        (nested / "b.txt").write_text("new")
        self.commit()
        target = self.home / "mods/fixture/nested"
        replaced = self.base / "replaced"
        class Swap(self.backend):
            def _write_live(inner, *args, **kwargs):
                target.rename(replaced)
                target.mkdir()
                (target / "sentinel").write_text("keep")
                super()._write_live(*args, **kwargs)
        self.bad(self.run_request("update", backend=Swap, **self.confirmation()), "Rollback could not be verified")
        self.assertEqual((target / "sentinel").read_text(), "keep")
        self.assertFalse((target / "b.txt").exists())
        self.assertEqual((replaced / "a.txt").read_text(), "old")
        self.assertTrue((self.state / "transaction.json").exists())

    def test_unsupported_safe_primitives_have_visible_reason(self):
        with mock.patch.object(operations, "fcntl", None):
            with self.assertRaisesRegex(operations.SafetyError, "Unsupported platform"):
                self.backend(str(self.home))
        self.assertFalse((self.home / "data").exists())

    def test_update_failure_rolls_back_and_verifies_previous_content(self):
        (self.repo / "a.txt").write_text("old")
        self.commit()
        self.install()
        before = self.confirmation()
        (self.repo / "a.txt").write_text("new")
        (self.repo / "main.js").write_text("export default {new:true};")
        self.commit()
        class Failure(self.backend):
            def _write_live(inner, name, inode, path, *args, **kwargs):
                if path == "main.js":
                    raise OSError("fixture update failed")
                super()._write_live(name, inode, path, *args, **kwargs)
        self.bad(self.run_request("update", backend=Failure, **before), "fixture update failed")
        self.assertEqual((self.home / "mods/fixture/a.txt").read_text(), "old")
        self.assertEqual(self.discover(runtimeKnown=True)["mods"][0]["commit"], before["expectedCommit"])
        self.assertNotIn("protectedReason", self.discover(runtimeKnown=True)["mods"][0])
        self.assertFalse((self.state / "transaction.json").exists())

    def test_uninstall_failure_restores_removed_files(self):
        (self.repo / "z.txt").write_text("preserve")
        self.commit()
        self.install()
        class Failure(self.backend):
            def _remove_live_file(inner, name, inode, path, *args):
                if path == "z.txt":
                    raise OSError("fixture remove failed")
                super()._remove_live_file(name, inode, path, *args)
        self.bad(self.run_request("uninstall", backend=Failure, **self.confirmation()), "fixture remove failed")
        self.assertTrue((self.home / "mods/fixture/main.js").exists())
        self.assertNotIn("protectedReason", self.discover(runtimeKnown=True)["mods"][0])

    def test_interrupt_retains_intent_backups_and_blocks_next_session(self):
        self.install()
        original_inode = (self.home / "mods/fixture/main.js").stat().st_ino
        (self.repo / "main.js").write_text("export default {next:true};")
        self.commit()
        class Interrupt(BaseException):
            pass
        class Crash(self.backend):
            def _write_live(inner, *args, **kwargs):
                super()._write_live(*args, **kwargs)
                raise Interrupt()
            def _rollback(inner, original):
                raise Interrupt()
        with self.assertRaises(Interrupt):
            self.run_request("update", backend=Crash, **self.confirmation())
        transaction = json.loads((self.state / "transaction.json").read_text())
        workspace = self.state / transaction["workspace"]
        backup = workspace / "backup/fixture/main.js"
        self.assertEqual(backup.read_text(), "export default {};\n")
        self.assertEqual((workspace / "displaced/fixture/main.js").stat().st_ino, original_inode)
        staged = workspace / "staged/fixture/main.js"
        self.assertEqual(staged.read_text(), "export default {next:true};")
        self.assertEqual(operations.digest(staged.read_bytes()), transaction["plan"]["fixture"]["files"]["main.js"]["sha256"])
        self.bad(self.run_request("update", **self.confirmation()), "Interrupted transaction")

    def test_rollback_refuses_modified_created_file(self):
        class Conflict(self.backend):
            def _write_live(inner, name, inode, path, *args, **kwargs):
                super()._write_live(name, inode, path, *args, **kwargs)
                (self.home / "mods" / name / path).write_text("external change")
                raise OSError("fixture failure")
        self.bad(self.run_request("install", backend=Conflict, repository="example/fixture"), "Rollback could not be verified")
        self.assertTrue((self.state / "transaction.json").exists())
        transaction = json.loads((self.state / "transaction.json").read_text())
        workspace = self.state / transaction["workspace"]
        preserved = list((self.home / "mods/fixture").rglob("*")) + list(workspace.rglob("*"))
        self.assertTrue(any(p.read_text() == "external change" for p in preserved if p.is_file()))

    def test_target_swap_before_live_commit_is_rejected(self):
        self.install()
        old = self.home / "mods/fixture"
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "sentinel").write_text("keep")
        (self.repo / "main.js").write_text("export default {next:true};")
        self.commit()
        class Swap(self.backend):
            def _transaction(inner, *args, **kwargs):
                super()._transaction(*args, **kwargs)
                old.rename(self.home / "mods/original")
                old.symlink_to(outside, target_is_directory=True)
        self.bad(self.run_request("update", backend=Swap, **self.confirmation()))
        self.assertEqual((outside / "sentinel").read_text(), "keep")
        self.assertEqual(list(outside.iterdir()), [outside / "sentinel"])
        # No live write happened before the external swap. Do not block unrelated
        # operations with a recovery marker; the swapped target itself is unknown.
        self.assertFalse((self.state / "transaction.json").exists())
        entry = next(mod for mod in self.discover(runtimeKnown=True)["mods"] if mod["id"] == "fixture")
        self.assertFalse(entry["managed"])
        self.assertIn("Symbolic-link", entry["protectedReason"])
        self.assertTrue((self.home / "mods/original/main.js").exists())

    def test_fsync_failure_after_root_publication_registers_undo(self):
        real_fsync = os.fsync
        fired = []
        class Failure(self.backend):
            def _mkdir_live(inner, name):
                def fsync(fd):
                    if fd == inner.mods and not fired:
                        fired.append(True)
                        raise OSError("fixture mkdir sync failed")
                    return real_fsync(fd)
                with mock.patch.object(operations.os, "fsync", side_effect=fsync):
                    return super()._mkdir_live(name)
        self.bad(self.run_request("install", backend=Failure, repository="example/fixture"), "fixture mkdir sync failed")
        self.assertTrue(fired)
        self.assertEqual(list((self.home / "mods").iterdir()), [])
        self.assertFalse((self.state / "transaction.json").exists())

    def test_fsync_failure_after_nested_publication_registers_undo(self):
        self.write_mod("nested")
        self.commit()
        real_fsync = os.fsync
        fired = []
        class Failure(self.backend):
            def _new_directory(inner, name, root_inode=None, path=None):
                if path is None:
                    return super()._new_directory(name, root_inode, path)
                def fsync(fd):
                    if operations.identity(os.fstat(fd)) == root_inode and not fired:
                        fired.append(True)
                        raise OSError("fixture nested sync failed")
                    return real_fsync(fd)
                with mock.patch.object(operations.os, "fsync", side_effect=fsync):
                    return super()._new_directory(name, root_inode, path)
        self.bad(self.run_request("install", backend=Failure, repository="example/fixture"), "fixture nested sync failed")
        self.assertTrue(fired)
        self.assertEqual(list((self.home / "mods").iterdir()), [])
        self.assertFalse((self.state / "transaction.json").exists())

    def test_fsync_failure_after_removal_restores_original_inode(self):
        self.install()
        target = self.home / "mods/fixture/main.js"
        before = target.stat().st_ino
        real_fsync = os.fsync
        fired = []
        class Failure(self.backend):
            def _remove_live_file(inner, name, root_inode, path, *args):
                def fsync(fd):
                    if operations.identity(os.fstat(fd)) == root_inode and not fired:
                        fired.append(True)
                        raise OSError("fixture removal sync failed")
                    return real_fsync(fd)
                with mock.patch.object(operations.os, "fsync", side_effect=fsync):
                    return super()._remove_live_file(name, root_inode, path, *args)
        self.bad(self.run_request("uninstall", backend=Failure, **self.confirmation()), "fixture removal sync failed")
        self.assertEqual(target.stat().st_ino, before)
        self.assertEqual(target.read_text(), "export default {};\n")
        self.assertFalse((self.state / "transaction.json").exists())

    def test_fsync_failure_after_prune_restores_original_directory_inode(self):
        (self.repo / "nested").mkdir()
        (self.repo / "nested/a.txt").write_text("old")
        self.commit()
        self.install()
        target = self.home / "mods/fixture/nested"
        before = target.stat().st_ino
        real_fsync = os.fsync
        fired = []
        class Failure(self.backend):
            def _move_directory(inner, name, root_inode, path, *args, **kwargs):
                def fsync(fd):
                    if operations.identity(os.fstat(fd)) == root_inode and not fired:
                        fired.append(True)
                        raise OSError("fixture prune sync failed")
                    return real_fsync(fd)
                with mock.patch.object(operations.os, "fsync", side_effect=fsync):
                    return super()._move_directory(name, root_inode, path, *args, **kwargs)
        self.bad(self.run_request("uninstall", backend=Failure, **self.confirmation()), "fixture prune sync failed")
        self.assertEqual(target.stat().st_ino, before)
        self.assertEqual((target / "a.txt").read_text(), "old")
        self.assertFalse((self.state / "transaction.json").exists())

    def test_fsync_failure_after_file_publication_restores_original_inode(self):
        self.install()
        confirmation = self.confirmation()
        target = self.home / "mods/fixture/main.js"
        before = target.stat().st_ino
        (self.repo / "main.js").write_text("export default {next:true};")
        self.commit()
        real_link, real_fsync = os.link, os.fsync
        published, fired = [], []
        class Failure(self.backend):
            def _write_live(inner, name, root_inode, path, *args, **kwargs):
                def link(*values, **options):
                    result = real_link(*values, **options)
                    published.append(True)
                    return result
                def fsync(fd):
                    if published and not fired and operations.identity(os.fstat(fd)) == root_inode:
                        fired.append(True)
                        raise OSError("fixture publication sync failed")
                    return real_fsync(fd)
                with mock.patch.object(operations.os, "link", side_effect=link), mock.patch.object(operations.os, "fsync", side_effect=fsync):
                    return super()._write_live(name, root_inode, path, *args, **kwargs)
        self.bad(self.run_request("update", backend=Failure, **confirmation), "fixture publication sync failed")
        self.assertTrue(fired)
        self.assertEqual(target.stat().st_ino, before)
        self.assertEqual(target.read_text(), "export default {};\n")
        self.assertFalse((self.state / "transaction.json").exists())

    def test_fsync_failure_after_final_root_move_restores_original_inode(self):
        self.install()
        confirmation = self.confirmation()
        target = self.home / "mods/fixture"
        before = target.stat().st_ino
        real_fsync = os.fsync
        fired = []
        class Failure(self.backend):
            def _move_directory(inner, name, root_inode, path, *args, **kwargs):
                def fsync(fd):
                    if path is None and fd == inner.mods and not fired:
                        fired.append(True)
                        raise OSError("fixture root removal sync failed")
                    return real_fsync(fd)
                with mock.patch.object(operations.os, "fsync", side_effect=fsync):
                    return super()._move_directory(name, root_inode, path, *args, **kwargs)
        self.bad(self.run_request("uninstall", backend=Failure, **confirmation), "fixture root removal sync failed")
        self.assertTrue(fired)
        self.assertEqual(target.stat().st_ino, before)
        self.assertEqual((target / "main.js").read_text(), "export default {};\n")
        self.assertFalse((self.state / "transaction.json").exists())

    def test_record_does_not_adopt_edit_after_package_verification(self):
        target = self.home / "mods/fixture/main.js"
        class Edit(self.backend):
            def _record(inner, *args):
                target.write_text("external edit after verification")
                return super()._record(*args)
        self.bad(self.run_request("install", backend=Edit, repository="example/fixture"), "Rollback could not be verified")
        registry = json.loads((self.state / "registry.json").read_text())
        self.assertNotIn("fixture", registry["mods"])
        journal = json.loads((self.state / "transaction.json").read_text())
        workspace = self.state / journal["workspace"]
        self.assertTrue(any(p.is_file() and p.read_bytes() == b"external edit after verification" for p in workspace.rglob("*")))

    def test_update_record_does_not_adopt_edit_after_verification(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        self.commit()
        class Edit(self.backend):
            def _record(inner, *args):
                (self.home / "mods/fixture/main.js").write_text("external update edit")
                return super()._record(*args)
        self.bad(self.run_request("update", backend=Edit, **before), "Rollback could not be verified")
        record = json.loads((self.state / "registry.json").read_text())["mods"]["fixture"]
        self.assertEqual(record["commit"], before["expectedCommit"])
        self.assertEqual(record["files"]["main.js"]["sha256"], operations.digest(b"export default {};\n"))
        journal = json.loads((self.state / "transaction.json").read_text())
        workspace = self.state / journal["workspace"]
        self.assertTrue(any(p.is_file() and p.read_bytes() == b"external update edit" for p in workspace.rglob("*")))
        self.assertEqual((workspace / "displaced/fixture/main.js").read_text(), "export default {};\n")

    def test_registry_parse_and_stamp_use_the_same_read(self):
        self.install()
        confirmation = self.confirmation()
        target = self.home / "mods/fixture/main.js"
        before = target.stat().st_ino
        registry_path = self.state / "registry.json"
        class ReplaceToken(self.backend):
            def _read_registry(inner, state, stamped=False):
                result = super()._read_registry(state, stamped=stamped)
                if stamped:
                    registry = json.loads(registry_path.read_text())
                    registry["mods"]["fixture"]["identityToken"] = "f" * 32
                    replacement = registry_path.with_name("replacement.json")
                    replacement.write_text(json.dumps(registry))
                    replacement.replace(registry_path)
                return result
        self.bad(self.run_request("uninstall", backend=ReplaceToken, **confirmation), "Registry changed")
        self.assertEqual(target.stat().st_ino, before)
        self.assertEqual(target.read_text(), "export default {};\n")
        self.assertFalse((self.state / "transaction.json").exists())

    def test_external_hardlink_added_after_validation_is_never_written(self):
        self.install()
        target = self.home / "mods/fixture/main.js"
        before = target.read_bytes()
        inode = target.stat().st_ino
        outside = self.base / "external-hardlink"
        (self.repo / "main.js").write_text("export default {next:true};")
        self.commit()
        class Link(self.backend):
            def _remove_live_file(inner, *args, **kwargs):
                os.link(target, outside)
                return super()._remove_live_file(*args, **kwargs)
        with mock.patch.object(operations.os, "ftruncate", side_effect=AssertionError("Live truncation is forbidden")):
            self.bad(self.run_request("update", backend=Link, **self.confirmation()), "Rollback could not be verified")
        self.assertEqual(outside.read_bytes(), before)
        self.assertEqual(outside.stat().st_ino, inode)
        transaction = json.loads((self.state / "transaction.json").read_text())
        saved = self.state / transaction["workspace"] / "displaced/fixture/main.js"
        self.assertEqual(saved.stat().st_ino, inode)
        self.assertEqual(saved.read_bytes(), before)

    def test_swapped_file_is_preserved_not_unlinked(self):
        self.install()
        target = self.home / "mods/fixture/main.js"
        original = self.base / "original-main.js"
        moved_inode = []
        real_rename = operations.rename_exclusive
        def swap(source_fd, source, target_fd, destination):
            if source == "main.js" and not moved_inode:
                target.rename(original)
                target.write_text("unrelated user file")
                moved_inode.append(target.stat().st_ino)
            return real_rename(source_fd, source, target_fd, destination)
        with mock.patch.object(operations, "rename_exclusive", side_effect=swap):
            self.bad(self.run_request("uninstall", **self.confirmation()), "Rollback could not be verified")
        transaction = json.loads((self.state / "transaction.json").read_text())
        saved = self.state / transaction["workspace"] / "displaced/fixture/main.js"
        self.assertEqual(saved.read_text(), "unrelated user file")
        self.assertEqual(saved.stat().st_ino, moved_inode[0])
        self.assertEqual(original.read_text(), "export default {};\n")

    def test_replacement_publication_never_overwrites_a_user_destination(self):
        self.install()
        confirmation = self.confirmation()
        target = self.home / "mods/fixture/main.js"
        old_inode = target.stat().st_ino
        (self.repo / "main.js").write_text("export default {next:true};")
        self.commit()
        real_link = os.link
        appeared = []
        def create_destination(source, destination, **kwargs):
            if destination == "main.js" and not appeared:
                target.write_text("new user destination")
                appeared.append(target.stat().st_ino)
            return real_link(source, destination, **kwargs)
        class Race(self.backend):
            def _write_live(inner, *args, **kwargs):
                # Inject after platform capability checks, at publication itself.
                with mock.patch.object(operations.os, "link", side_effect=create_destination):
                    return super()._write_live(*args, **kwargs)
        self.bad(self.run_request("update", backend=Race, **confirmation), "Rollback could not be verified")
        self.assertEqual(target.read_text(), "new user destination")
        self.assertEqual(target.stat().st_ino, appeared[0])
        transaction = json.loads((self.state / "transaction.json").read_text())
        original = self.state / transaction["workspace"] / "displaced/fixture/main.js"
        self.assertEqual(original.stat().st_ino, old_inode)

    def test_rollback_move_preserves_a_file_swapped_after_validation(self):
        self.install()
        target = self.home / "mods/fixture/main.js"
        (self.repo / "main.js").write_text("export default {next:true};")
        self.commit()
        user_inode = []
        real_rename = operations.rename_exclusive
        class Failure(self.backend):
            def _write_live(inner, *args, **kwargs):
                super()._write_live(*args, **kwargs)
                raise OSError("fixture commit failure")
        def swap(source_fd, source, target_fd, destination):
            if source == "main.js" and not user_inode:
                # Only rollback's retirement has a UUID leaf in retired/.
                if len(destination) == 32:
                    target.rename(self.base / "published-main.js")
                    target.write_text("rollback user file")
                    user_inode.append(target.stat().st_ino)
            return real_rename(source_fd, source, target_fd, destination)
        with mock.patch.object(operations, "rename_exclusive", side_effect=swap):
            self.bad(self.run_request("update", backend=Failure, **self.confirmation()), "Rollback could not be verified")
        transaction = json.loads((self.state / "transaction.json").read_text())
        retired = list((self.state / transaction["workspace"] / "retired").iterdir())
        self.assertEqual(len(retired), 1)
        self.assertEqual(retired[0].stat().st_ino, user_inode[0])
        self.assertEqual(retired[0].read_text(), "rollback user file")

    def test_mutation_parent_swap_after_validation_preserves_unrelated_files(self):
        (self.repo / "nested").mkdir()
        (self.repo / "nested/a.txt").write_text("original")
        self.commit()
        self.install()
        confirmation = self.confirmation()
        target = self.home / "mods/fixture/nested"
        detached = self.base / "detached-nested"
        swapped = []
        class Swap(self.backend):
            def _remove_live_file(inner, *args, **kwargs):
                original_parent = inner.fs.parent
                @contextlib.contextmanager
                def parent(base, path, create=False):
                    if path == "nested/a.txt" and not create and not swapped:
                        target.rename(detached)
                        target.mkdir()
                        (target / "a.txt").write_text("unrelated")
                        swapped.append((target / "a.txt").stat().st_ino)
                    with original_parent(base, path, create=create) as result:
                        yield result
                with mock.patch.object(inner.fs, "parent", side_effect=parent):
                    return super()._remove_live_file(*args, **kwargs)
        self.bad(self.run_request("uninstall", backend=Swap, **confirmation), "Rollback could not be verified")
        self.assertEqual((target / "a.txt").read_text(), "unrelated")
        self.assertEqual((target / "a.txt").stat().st_ino, swapped[0])
        self.assertEqual((detached / "a.txt").read_text(), "original")
        self.assertTrue((self.state / "transaction.json").exists())

    def test_new_file_parent_swap_after_validation_never_writes_unowned_directory(self):
        (self.repo / "nested").mkdir()
        (self.repo / "nested/a.txt").write_text("original")
        self.commit()
        self.install()
        (self.repo / "nested/b.txt").write_text("new")
        self.commit()
        target = self.home / "mods/fixture/nested"
        detached = self.base / "detached-nested"
        swapped = []
        class Swap(self.backend):
            def _write_live(inner, *args, **kwargs):
                original_parent = inner.fs.parent
                @contextlib.contextmanager
                def parent(base, path, create=False):
                    if path == "nested/b.txt" and not create and not swapped:
                        target.rename(detached)
                        target.mkdir()
                        (target / "sentinel").write_text("keep")
                        swapped.append(True)
                    with original_parent(base, path, create=create) as result:
                        yield result
                with mock.patch.object(inner.fs, "parent", side_effect=parent):
                    return super()._write_live(*args, **kwargs)
        self.bad(self.run_request("update", backend=Swap, **self.confirmation()), "Rollback could not be verified")
        self.assertTrue(swapped)
        self.assertEqual((target / "sentinel").read_text(), "keep")
        self.assertFalse((target / "b.txt").exists())
        self.assertEqual((detached / "a.txt").read_text(), "original")

    def test_final_uninstall_root_swap_preserves_unknown_directory(self):
        self.install()
        target = self.home / "mods/fixture"
        detached = self.base / "original-empty-root"
        swapped = []
        class Swap(self.backend):
            def _move_directory(inner, name, root_inode, path, inode, restore=True):
                if path is None and restore and not swapped:
                    target.rename(detached)
                    target.mkdir()
                    (target / "sentinel").write_text("unrelated directory")
                    swapped.append(target.stat().st_ino)
                return super()._move_directory(name, root_inode, path, inode, restore=restore)
        self.bad(self.run_request("uninstall", backend=Swap, **self.confirmation()), "Rollback could not be verified")
        transaction = json.loads((self.state / "transaction.json").read_text())
        saved = self.state / transaction["workspace"] / "displaced-dirs/fixture" / operations.digest(b"")
        self.assertEqual(saved.stat().st_ino, swapped[0])
        self.assertEqual((saved / "sentinel").read_text(), "unrelated directory")
        self.assertTrue(detached.is_dir())

    def test_prepare_update_is_read_only_and_commit_uses_no_git(self):
        self.install()
        before = self.confirmation()
        target = self.home / "mods/fixture/main.js"
        original_inode = target.stat().st_ino
        (self.repo / "main.js").write_text("export default {prepared:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        self.assertRegex(prepared["stageToken"], r"^[0-9a-f]{32}$")
        self.assertEqual(prepared["commit"], candidate)
        self.assertEqual(target.stat().st_ino, original_inode)
        self.assertEqual(target.read_text(), "export default {};\n")
        self.assertFalse((self.state / "transaction.json").exists())
        class NoNetwork(self.backend):
            def _clone(inner, *args):
                raise AssertionError("Commit must not clone")
            def _git(inner, *args):
                raise AssertionError("Commit must not call git")
        # Advancing HEAD after prepare cannot change the checked staged bytes.
        (self.repo / "main.js").write_text("export default {unreviewed:true};")
        self.commit()
        result = self.good(self.run_request("update", backend=NoNetwork, **before, targetCommit=candidate, stageToken=prepared["stageToken"]))
        self.assertEqual(result["commit"], candidate)
        self.assertEqual(target.read_text(), "export default {prepared:true};")
        self.assertFalse((self.state / ("work-" + prepared["stageToken"])).exists())
        self.assertFalse((self.state / ("stage-" + prepared["stageToken"] + ".json")).exists())

    def test_fresh_runtime_dependencies_after_prepare_block_update(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        fresh = {**before, "dependencies": ["fixture"]}
        self.bad(self.run_request("update", **fresh, targetCommit=candidate, stageToken=prepared["stageToken"]), "runtime dependency")
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "export default {};\n")
        self.assertFalse((self.state / "transaction.json").exists())

    def test_changed_metadata_after_prepare_blocks_update(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        (self.home / "keys.json").write_text('{"mod":"fixture"}')
        self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=prepared["stageToken"]), "dependency")
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "export default {};\n")

    def test_target_head_drift_is_rejected_before_live_writes(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {checked:true};")
        checked = self.commit()
        (self.repo / "main.js").write_text("export default {unreviewed:true};")
        self.commit()
        self.bad(self.run_request("prepare-update", **before, targetCommit=checked), "targetCommit")
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "export default {};\n")
        self.assertEqual(list(self.state.glob("work-*")), [])
        self.assertFalse((self.state / "transaction.json").exists())

    def test_update_requires_production_stage_token(self):
        self.install()
        self.bad(self.run_request("update", backend=operations.Operations, **self.confirmation()), "stageToken")
        self.bad(self.run_request("prepare-update", id="fixture", targetCommit="HEAD"), "targetCommit")
        self.bad(self.run_request("update", **self.confirmation(), stageToken="a" * 32), "stage")

    def test_successful_stage_is_single_use(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        self.good(self.run_request("update", **before, targetCommit=candidate, stageToken=prepared["stageToken"]))
        self.bad(self.run_request("update", **self.confirmation(), targetCommit=candidate, stageToken=prepared["stageToken"]), "stage")

    def test_tampered_stage_files_are_rejected_and_retained(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        work = self.state / ("work-" + prepared["stageToken"])
        (work / "prepared/fixture/main.js").write_text("tampered stage")
        self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=prepared["stageToken"]), "stage changed")
        self.assertEqual((work / "prepared/fixture/main.js").read_text(), "tampered stage")
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "export default {};\n")
        self.assertFalse((self.state / "transaction.json").exists())

    def test_stage_tampered_after_intent_is_retained_without_live_writes(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        work = self.state / ("work-" + prepared["stageToken"])
        class Tamper(self.backend):
            def _transaction(inner, *args):
                super()._transaction(*args)
                (work / "prepared/fixture/main.js").write_text("late tampered stage")
        self.bad(self.run_request("update", backend=Tamper, **before, targetCommit=candidate, stageToken=prepared["stageToken"]), "stage changed")
        self.assertEqual((work / "prepared/fixture/main.js").read_text(), "late tampered stage")
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "export default {};\n")
        self.assertFalse((self.state / "transaction.json").exists())
        self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=prepared["stageToken"]), "already consumed")

    def test_tampered_stage_manifest_cannot_redefine_verified_hashes(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        work = self.state / ("work-" + prepared["stageToken"])
        staged = work / "prepared/fixture/main.js"
        staged.write_text("tampered stage")
        manifest_path = work / "prepared.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["snapshot"]["files"]["main.js"].update(sha256=operations.digest(staged.read_bytes()), size=staged.stat().st_size)
        manifest_path.write_text(json.dumps(manifest))
        self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=prepared["stageToken"]), "provenance changed")
        self.assertTrue(work.is_dir())
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "export default {};\n")

    def test_replaced_workspace_identity_is_rejected_without_cleanup(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        work = self.state / ("work-" + prepared["stageToken"])
        detached = self.state / "detached-original-stage"
        work.rename(detached)
        shutil.copytree(detached, work)
        self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=prepared["stageToken"]), "provenance changed")
        self.assertTrue(work.is_dir())
        self.assertTrue(detached.is_dir())
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "export default {};\n")

    def test_stage_is_bound_to_target_and_original_identity(self):
        self.install()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {next:true};")
        candidate = self.commit()
        prepared = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        token = prepared["stageToken"]
        self.bad(self.run_request("update", **before, targetCommit="0" * 40, stageToken=token), "targetCommit")
        self.bad(self.run_request("update", **{**before, "identityToken": "0" * 32}, targetCommit=candidate, stageToken=token), "identity")
        self.good(self.run_request("uninstall", **before))
        self.install()
        self.bad(self.run_request("update", **self.confirmation(), targetCommit=candidate, stageToken=token), "stage identity")
        self.assertEqual(self.discover()["mods"][0]["commit"], candidate)

    def test_unrelated_local_edit_does_not_block_verified_rollback(self):
        self.install()
        original = self.home / "mods/fixture/main.js"
        original.write_text("// unrelated user edit")

        class FailedSecond(self.backend):
            def _write_live(inner, *args, **kwargs):
                raise OSError("second install failed")

        result = self.run_request("install", backend=FailedSecond, repository="example/second")
        self.bad(result, "second install failed")
        self.assertFalse((self.home / "mods/second").exists())
        self.assertFalse((self.state / "transaction.json").exists())
        self.assertEqual(original.read_text(), "// unrelated user edit")
        self.good(self.run_request("install", repository="example/third"))
        self.assertEqual(original.read_text(), "// unrelated user edit")

    def test_shipped_layout_name_is_not_a_shipped_mod_identity(self):
        folder = self.home / "mods/main"
        folder.mkdir()
        (folder / "mod.json").write_text('{"place":"none"}')
        (folder / "main.js").write_text("export default {};")
        (self.home / "installed.json").write_text('{"layout:main":{"json":"fingerprint"}}')
        entry = self.discover(runtimeKnown=True)["mods"][0]
        self.assertEqual(entry["id"], "main")
        self.assertEqual(entry["source"], "local")
        self.assertFalse(entry["managed"])

    def test_oversized_metadata_is_rejected_without_replacing_existing_state(self):
        path = self.home / "metadata.json"
        path.write_text('{"keep":true}')
        safe = operations.SafeFS(str(self.home))
        try:
            with mock.patch.object(operations, "LIMIT", 16):
                with self.assertRaisesRegex(operations.SafetyError, "metadata exceeds"):
                    safe.atomic(safe.root, "metadata.json", b"x" * 17)
        finally:
            safe.close()
        self.assertEqual(path.read_text(), '{"keep":true}')

    def test_old_cached_python_is_rejected_before_filesystem_changes(self):
        with mock.patch.object(operations.sys, "version_info", (3, 8, 0)):
            with self.assertRaisesRegex(operations.SafetyError, "Python 3.9"):
                self.backend(str(self.home))
        self.assertFalse((self.home / "data").exists())
        self.assertEqual(list((self.home / "mods").iterdir()), [])

    def test_cli_one_json_even_on_validation_failure(self):
        result = subprocess.run(
            ["uv", "run", "--offline", "--no-project", "python", str(Path(operations.__file__)), str(self.home), '{"action":"discover"}'],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True,
        )
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertTrue(json.loads(result.stdout)["ok"])
        result = subprocess.run(
            ["uv", "run", "--offline", "--no-project", "python", str(Path(operations.__file__)), str(self.home), '{"action":"discover","action":"install"}'],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True,
        )
        self.assertFalse(json.loads(result.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
