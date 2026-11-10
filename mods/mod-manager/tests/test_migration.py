"""Real Git and migration faults. All profiles and transports are temporary."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest import mock

import test_operations as fixtures

operations = fixtures.operations


@unittest.skipUnless(os.name == "posix" and shutil.which("git"), "POSIX and Git required")
class MigrationTests(unittest.TestCase):
    setUp = fixtures.LifecycleTests.setUp
    tearDown = fixtures.LifecycleTests.tearDown
    git = fixtures.LifecycleTests.git
    write_mod = fixtures.LifecycleTests.write_mod
    commit = fixtures.LifecycleTests.commit
    run_request = fixtures.LifecycleTests.run_request
    good = fixtures.LifecycleTests.good
    bad = fixtures.LifecycleTests.bad
    install = fixtures.LifecycleTests.install
    discover = fixtures.LifecycleTests.discover
    confirmation = fixtures.LifecycleTests.confirmation
    state = fixtures.LifecycleTests.state

    def legacy_package(self):
        self.install()
        registry = json.loads((self.state / "registry.json").read_text())
        registry["version"] = 1
        for record in [*registry["mods"].values(), *registry["history"]]:
            record.pop("kind")
        (self.state / "registry.json").write_bytes(operations.encode(registry))
        (self.state / "lock").write_bytes(operations.encode({"version": 1}))
        return registry

    def legacy_git(self, name="fixture", branch="main"):
        target = self.home / "mods" / name
        subprocess.run(["git", "clone", "--no-hardlinks", "--template=", "--branch", branch, str(self.repo), str(target)],
                       env={"PATH": os.environ["PATH"], "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
        self.live_git(target, "config", "remote.origin.url", "https://github.com/example/" + name + ".git")
        (target / ".git/herdr-mod-manager.json").write_bytes(operations.encode({"version": 1, "url": "https://github.com/example/" + name + ".git", "branch": branch}))
        return target

    def live_git(self, target, *args):
        result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *args], cwd=target,
                                env={"PATH": os.environ["PATH"], "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0"},
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
        return result.stdout.decode().strip()

    def migrate(self, backend=None, **fields):
        summary = self.discover(runtimeKnown=True)["migration"]
        self.assertTrue(summary["required"], summary)
        self.assertFalse(summary["blocked"], summary)
        return self.good(self.run_request("migrate", backend=backend, migrationToken=summary["token"], **fields))

    def tree(self):
        return {str(p.relative_to(self.home)): (p.read_bytes(), operations.identity(p.stat()))
                for p in self.home.rglob("*") if p.is_file() and not p.is_symlink()}

    def test_fresh_only_explicit_install_initializes_v2(self):
        before = self.tree()
        summary = self.discover()["migration"]
        self.assertFalse(summary["required"])
        self.assertFalse(summary["blocked"])
        self.good(self.run_request("migrate", migrationToken=summary["token"]))
        self.bad(self.run_request("check-update", id="fixture"), "explicit install")
        self.assertEqual(self.tree(), before)
        self.assertFalse((self.home / "data").exists())
        self.install()
        self.assertEqual(json.loads((self.state / "lock").read_text()), {"version": 2})
        self.assertEqual(json.loads((self.state / "registry.json").read_text())["version"], 2)

    def test_v1_migration_retains_preimages_and_lock_inode(self):
        old = self.legacy_package()
        before = self.tree()
        lock_inode = (self.state / "lock").stat().st_ino
        result = self.discover(runtimeKnown=True)
        self.assertEqual(before, self.tree())
        self.assertEqual(result["migration"]["targets"][0]["kind"], "package")
        self.bad(self.run_request("check-update", id="fixture"), "migration")
        self.bad(self.run_request("migrate", migrationToken="0" * 64), "migrationToken")
        self.migrate()
        self.assertEqual((self.state / "lock").stat().st_ino, lock_inode)
        new = json.loads((self.state / "registry.json").read_text())
        self.assertEqual(new["mods"]["fixture"], {**old["mods"]["fixture"], "kind": "package"})
        journal = json.loads((self.state / "migration.json").read_text())
        self.assertEqual(journal["phase"], "complete")
        self.assertEqual(json.loads((self.state / journal["workspace"] / "registry.json").read_text()), old)
        self.assertEqual((self.state / journal["workspace"] / "lock").read_bytes(), operations.encode({"version": 1}))
        for path, value in before.items():
            if path.startswith("mods/"):
                self.assertEqual(self.tree()[path], value)
        after = self.tree()
        summary = self.discover()["migration"]
        self.good(self.run_request("migrate", migrationToken=summary["token"]))
        self.assertEqual(self.tree(), after)
        self.good(self.run_request("uninstall", **self.confirmation()))

    def test_main_migration_keeps_checkout_history_and_identity(self):
        target = self.legacy_git()
        self.live_git(target, "branch", "private-local-ref")
        before = self.tree()
        self.migrate()
        for path, value in before.items():
            if path.startswith("mods/"):
                self.assertEqual(self.tree()[path], value)
        record = json.loads((self.state / "registry.json").read_text())["mods"]["fixture"]
        self.assertEqual(record["kind"], "git")
        self.assertEqual(record["branch"], "main")
        self.assertEqual(self.live_git(target, "rev-parse", "private-local-ref"), record["commit"])
        self.assertNotIn("protectedReason", self.discover(runtimeKnown=True)["mods"][0])

    def test_disjoint_mixed_migrates_verified_union(self):
        self.legacy_package()
        self.legacy_git("other")
        summary = self.discover()["migration"]
        self.assertFalse(summary["blocked"], summary)
        self.assertEqual({t["kind"] for t in summary["targets"]}, {"package", "git"})
        self.migrate()
        self.assertEqual(set(json.loads((self.state / "registry.json").read_text())["mods"]), {"fixture", "other"})

    def test_conflicting_mixed_never_adopts(self):
        self.legacy_package()
        (self.home / "mods/fixture").rename(self.base / "package")
        self.legacy_git()
        before = self.tree()
        summary = self.discover()["migration"]
        self.assertTrue(summary["blocked"], summary)
        self.bad(self.run_request("migrate", migrationToken=summary["token"]))
        self.assertEqual(before, self.tree())

    def test_directory_and_corrupt_locks_never_removed(self):
        self.legacy_git()
        self.state.mkdir(parents=True)
        lock = self.state / "lock"
        lock.mkdir()
        (lock / "owner").write_text("unknown writer")
        inode = lock.stat().st_ino
        before = self.tree()
        summary = self.discover()["migration"]
        self.assertTrue(summary["blocked"])
        self.assertIn("cannot prove", summary["reason"])
        self.bad(self.run_request("migrate", migrationToken=summary["token"]))
        self.assertEqual(lock.stat().st_ino, inode)
        self.assertEqual(before, self.tree())
        (lock / "owner").unlink()
        lock.rmdir()
        lock.write_text("corrupt")
        self.assertTrue(self.discover()["migration"]["blocked"])
        self.assertEqual(lock.read_text(), "corrupt")

    def test_active_v1_lock_blocks_discovery_and_migration(self):
        self.legacy_package()
        with (self.state / "lock").open("rb") as held:
            operations.fcntl.flock(held, operations.fcntl.LOCK_EX | operations.fcntl.LOCK_NB)
            before = self.tree()
            summary = self.discover()["migration"]
            self.assertTrue(summary["blocked"])
            self.bad(self.run_request("migrate", migrationToken=summary["token"]), "Another lifecycle")
            self.assertEqual(before, self.tree())
        self.migrate()

    def test_dirty_ignored_generated_and_staged_git_fail_closed(self):
        target = self.legacy_git()
        for path in ("main.js", "gpui-kit.d.ts", "jsconfig.json"):
            original = (target / path).read_bytes() if (target / path).exists() else None
            (target / path).write_text("// user data")
            before = self.tree()
            self.assertTrue(self.discover()["migration"]["blocked"])
            self.assertEqual(before, self.tree())
            if original is None:
                (target / path).unlink()
            else:
                (target / path).write_bytes(original)
        (target / ".git/info").mkdir(exist_ok=True)
        (target / ".git/info/exclude").write_text("gpui-kit.d.ts\n")
        (target / "gpui-kit.d.ts").write_text("// ignored user data")
        self.assertTrue(self.discover()["migration"]["blocked"])
        (target / "gpui-kit.d.ts").unlink()
        (target / "main.js").write_text("// staged user data")
        self.live_git(target, "add", "main.js")
        self.assertTrue(self.discover()["migration"]["blocked"])
        self.assertIn("staged", self.discover()["migration"]["reason"])

    def test_linked_git_metadata_and_object_storage_block(self):
        target = self.legacy_git()
        config = target / ".git/config"
        external = self.base / "external-config"
        config.rename(external)
        config.symlink_to(external)
        self.assertTrue(self.discover()["migration"]["blocked"])
        config.unlink()
        external.rename(config)
        os.link(config, external)
        self.assertTrue(self.discover()["migration"]["blocked"])
        external.unlink()
        objects = target / ".git/objects"
        objects.rename(self.base / "objects")
        objects.symlink_to(self.base / "objects", target_is_directory=True)
        self.assertTrue(self.discover()["migration"]["blocked"])
        self.assertTrue(objects.is_symlink())

    def test_unsafe_git_config_and_alternates_block(self):
        target = self.legacy_git()
        marker = self.base / "executed"
        self.live_git(target, "config", "filter.evil.clean", "touch " + str(marker))
        self.assertTrue(self.discover()["migration"]["blocked"])
        self.assertFalse(marker.exists())
        self.live_git(target, "config", "--remove-section", "filter.evil")
        (target / ".git/objects/info").mkdir(exist_ok=True)
        (target / ".git/objects/info/alternates").write_text(str(self.repo / ".git/objects"))
        self.assertTrue(self.discover()["migration"]["blocked"])

    def test_migration_interrupt_each_phase_explicit_verified_resume(self):
        self.legacy_package()
        summary = self.discover()["migration"]
        for point in ("intent", "lock", "registry", "initialized", "completion-receipt", "complete"):
            # Resume the same migration at successively later durable boundaries.
            class Crash(self.backend):
                def _migration_point(inner, reached):
                    if reached == point:
                        raise OSError("migration crash at " + point)
            self.bad(self.run_request("migrate", backend=Crash, migrationToken=summary["token"]), "migration crash")
            journal = json.loads((self.state / "migration.json").read_text())
            self.assertTrue((self.state / journal["workspace"] / "registry.json").exists())
            result = self.discover()["migration"]
            if point == "complete":
                self.assertFalse(result["required"])
            else:
                self.assertTrue(result["required"], result)
                self.assertFalse(result["blocked"], result)
                self.assertEqual(result["token"], summary["token"])
                self.bad(self.run_request("check-update", id="fixture"), "migration")
        self.assertFalse(self.discover()["migration"]["required"])

    def test_changed_backup_or_source_blocks_resume(self):
        self.legacy_package()
        class Crash(self.backend):
            def _migration_point(inner, point):
                if point == "lock":
                    raise OSError("interrupted")
        summary = self.discover()["migration"]
        self.bad(self.run_request("migrate", backend=Crash, migrationToken=summary["token"]))
        journal = json.loads((self.state / "migration.json").read_text())
        backup = self.state / journal["workspace"] / "registry.json"
        backup.write_text("tampered")
        before = self.tree()
        summary = self.discover()["migration"]
        self.assertTrue(summary["blocked"])
        self.bad(self.run_request("migrate", migrationToken=summary["token"]))
        self.assertEqual(before, self.tree())
        self.assertIn("preimages", summary["reason"])

    def prepared_git_update(self, branch="main"):
        target = self.legacy_git(branch=branch)
        self.live_git(target, "branch", "local-history")
        self.migrate()
        before = self.confirmation()
        (self.repo / "main.js").write_text("export default {updated:true};\n")
        candidate = self.commit()
        stage = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))
        return target, before, candidate, stage["stageToken"]

    def assert_old_checkout(self, target, before):
        self.assertEqual(self.live_git(target, "rev-parse", "HEAD"), before["expectedCommit"])
        self.assertEqual(self.live_git(target, "status", "--porcelain=v1", "--ignored=matching"), "")
        self.assertEqual((target / "main.js").read_text(), "export default {};\n")
        self.assertEqual(self.live_git(target, "rev-parse", "local-history"), before["expectedCommit"])
        self.assertFalse((self.state / "transaction.json").exists())
        self.assertNotIn("protectedReason", self.discover(runtimeKnown=True)["mods"][0])

    def test_legacy_git_checked_update_retains_refs_history_identity(self):
        target, before, candidate, token = self.prepared_git_update()
        root, git = target.stat().st_ino, (target / ".git").stat().st_ino
        class NoNetwork(self.backend):
            def _clone(inner, *args):
                raise AssertionError("live apply must not use transport")
        self.good(self.run_request("update", backend=NoNetwork, **before, targetCommit=candidate, stageToken=token))
        self.assertEqual(target.stat().st_ino, root)
        self.assertEqual((target / ".git").stat().st_ino, git)
        self.assertEqual(self.live_git(target, "rev-parse", "HEAD"), candidate)
        self.assertEqual(self.live_git(target, "rev-parse", "local-history"), before["expectedCommit"])
        self.assertEqual(self.live_git(target, "cat-file", "-t", before["expectedCommit"]), "commit")
        self.assertEqual(self.live_git(target, "status", "--porcelain=v1"), "")
        self.assertNotIn("protectedReason", self.discover(runtimeKnown=True)["mods"][0])

    def test_branch_tag_collisions_main_and_release_stable(self):
        for branch in ("main", "release/stable"):
            with self.subTest(branch=branch):
                if branch != "main":
                    self.git("checkout", "-b", branch)
                target = self.legacy_git(branch=branch)
                self.migrate()
                before = self.confirmation()
                self.git("tag", branch)
                self.write_mod(text="export default " + json.dumps({"branch": branch}) + ";\n")
                candidate = self.commit()
                self.good(self.run_request("update", **before, targetCommit=candidate))
                self.assertEqual(self.live_git(target, "rev-parse", "HEAD"), candidate)
                confirmation = self.confirmation()
                archive = self.discover()["mods"][0]["archivePath"]
                self.good(self.run_request("uninstall", **confirmation, archiveGit=True, archivePath=archive))

    def test_preexisting_ref_lock_no_head_or_file_changes(self):
        target, before, candidate, token = self.prepared_git_update()
        ref_lock = target / ".git/refs/heads/main.lock"
        ref_lock.write_text("external writer")
        state = self.tree()
        self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=token), "lock")
        self.assertEqual(self.tree(), state)
        self.assertEqual(self.live_git(target, "rev-parse", "HEAD"), before["expectedCommit"])
        self.assertFalse((self.state / "transaction.json").exists())

    def test_git_failures_after_ref_files_and_index_roll_back(self):
        for point in ("before-ref", "ref-retired", "ref", "files", "index-retired", "index"):
            with self.subTest(point=point):
                if not (self.home / "mods/fixture").exists():
                    target, before, candidate, token = self.prepared_git_update()
                else:
                    target = self.home / "mods/fixture"
                    before = self.confirmation()
                    candidate = self.git("rev-parse", "HEAD")
                    token = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))["stageToken"]
                class Failure(self.backend):
                    def _git_point(inner, reached):
                        if reached == point:
                            raise OSError("git fault at " + point)
                self.bad(self.run_request("update", backend=Failure, **before, targetCommit=candidate, stageToken=token), "git fault")
                self.assert_old_checkout(target, before)

    def test_git_registry_completion_failure_rolls_back(self):
        target, before, candidate, token = self.prepared_git_update()
        class Failure(self.backend):
            def _finish(inner):
                inner._save_registry()
                raise OSError("registry completion failure")
        self.bad(self.run_request("update", backend=Failure, **before, targetCommit=candidate, stageToken=token), "registry completion failure")
        self.assert_old_checkout(target, before)

    def test_git_live_file_failure_and_rollback_conflict_keep_journal(self):
        target, before, candidate, token = self.prepared_git_update()
        class Conflict(self.backend):
            def _write_live(inner, *args, **kwargs):
                super()._write_live(*args, **kwargs)
                (target / "main.js").write_text("// external edit")
                raise OSError("file failure")
        self.bad(self.run_request("update", backend=Conflict, **before, targetCommit=candidate, stageToken=token), "Rollback could not be verified")
        journal = json.loads((self.state / "transaction.json").read_text())
        work = self.state / journal["workspace"]
        self.assertEqual((work / "backup-git/fixture/index").read_bytes()[:4], b"DIRC")
        self.assertTrue(any(p.is_file() and p.read_bytes() == b"// external edit" for p in work.rglob("*")))
        self.assertTrue(self.discover()["migration"]["blocked"])
        self.bad(self.run_request("check-update", id="fixture"), "Interrupted transaction")

    def test_git_uninstall_requires_archive_consent_and_keeps_history(self):
        target = self.legacy_git()
        self.live_git(target, "branch", "local-history")
        self.migrate()
        before = self.confirmation()
        entry = self.discover()["mods"][0]
        archive = entry["archivePath"]
        self.bad(self.run_request("uninstall", **before), "archivePath")
        self.bad(self.run_request("uninstall", **before, archivePath=archive), "archivePath")
        self.bad(self.run_request("uninstall", **before, archiveGit=True, archivePath=archive + "bad"), "archivePath")
        self.good(self.run_request("uninstall", **before, archiveGit=True, archivePath=archive))
        self.assertFalse(target.exists())
        self.assertEqual(self.live_git(Path(archive), "rev-parse", "local-history"), before["expectedCommit"])
        self.assertEqual(self.live_git(Path(archive), "rev-list", "--all"), before["expectedCommit"])
        self.assertTrue((Path(archive) / ".git/herdr-mod-manager.json").is_file())

    def test_external_git_status_refresh_is_not_a_code_change(self):
        target, before, candidate, token = self.prepared_git_update()
        self.good(self.run_request("update", **before, targetCommit=candidate, stageToken=token))
        # Do NOT suppress Git's normal optional index refresh in this probe.
        subprocess.run(["git", "status", "--porcelain"], cwd=target,
                       env={"PATH": os.environ["PATH"], "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
        self.assertNotIn("protectedReason", self.discover(runtimeKnown=True)["mods"][0])
        before = self.confirmation()
        archive = self.discover()["mods"][0]["archivePath"]
        self.good(self.run_request("uninstall", **before, archiveGit=True, archivePath=archive))

    def test_old_pr5_and_main_lock_protocols_reject_v2(self):
        self.install()
        lock = self.state / "lock"
        inode = lock.stat().st_ino
        # The old main writer uses mkdir at this exact pathname.
        with self.assertRaises(FileExistsError):
            lock.mkdir()
        # Reproduce PR5's exact v1 lock parser without relying on external files.
        with lock.open("rb") as held:
            operations.fcntl.flock(held, operations.fcntl.LOCK_EX | operations.fcntl.LOCK_NB)
            self.assertNotEqual(json.loads(held.read()), {"version": 1})
        self.assertEqual(lock.stat().st_ino, inode)
        self.assertEqual(json.loads((self.state / "registry.json").read_text())["version"], 2)

    def test_lock_inode_replacement_interrupts_migration_without_unlink(self):
        self.legacy_package()
        old_inode = (self.state / "lock").stat().st_ino
        class Swap(self.backend):
            def _migration_point(inner, point):
                if point == "intent":
                    (self.state / "lock").rename(self.state / "detached-lock")
                    (self.state / "lock").write_bytes(operations.encode({"version": 1}))
        summary = self.discover()["migration"]
        self.bad(self.run_request("migrate", backend=Swap, migrationToken=summary["token"]), "lock changed")
        self.assertEqual((self.state / "detached-lock").stat().st_ino, old_inode)
        self.assertNotEqual((self.state / "lock").stat().st_ino, old_inode)
        self.assertTrue(self.discover()["migration"]["blocked"])
        self.assertTrue((self.state / "migration.json").is_file())

    def test_corrupt_completed_migration_journal_blocks_read_only(self):
        self.legacy_package()
        self.migrate()
        for data in ([], {"phase": "complete"}, {"version": 2, "phase": "unknown"}):
            (self.state / "migration.json").write_bytes(operations.encode(data))
            before = self.tree()
            summary = self.discover()["migration"]
            self.assertTrue(summary["blocked"], summary)
            self.bad(self.run_request("migrate", migrationToken=summary["token"]))
            self.assertEqual(before, self.tree())

    def test_source_edit_after_intent_blocks_resume_without_overwrite(self):
        self.legacy_package()
        class Crash(self.backend):
            def _migration_point(inner, point):
                if point == "registry":
                    (self.home / "mods/fixture/main.js").write_text("// later edit")
                    raise OSError("interrupted after registry")
        summary = self.discover()["migration"]
        self.bad(self.run_request("migrate", backend=Crash, migrationToken=summary["token"]))
        before = self.tree()
        summary = self.discover()["migration"]
        self.assertTrue(summary["blocked"])
        self.bad(self.run_request("migrate", migrationToken=summary["token"]))
        self.assertEqual(before, self.tree())
        self.assertEqual((self.home / "mods/fixture/main.js").read_text(), "// later edit")

    def test_git_cas_errors_before_and_after_success_restore_old_checkout(self):
        target, before, candidate, token = self.prepared_git_update()
        for after in (False, True):
            with self.subTest(after=after):
                if after:
                    before = self.confirmation()
                    token = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))["stageToken"]
                class Failure(self.backend):
                    def _git_ref(inner, *args):
                        if after:
                            super()._git_ref(*args)
                        raise OSError("CAS result fault")
                self.bad(self.run_request("update", backend=Failure, **before, targetCommit=candidate, stageToken=token), "CAS result fault")
                self.assert_old_checkout(target, before)

    def test_git_pack_and_index_tampering_never_touches_live_checkout(self):
        target, before, candidate, token = self.prepared_git_update()
        for leaf in ("index", "objects.pack"):
            with self.subTest(leaf=leaf):
                if leaf != "index":
                    token = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))["stageToken"]
                prepared = self.state / ("work-" + token) / "git-prepared" / leaf
                prepared.write_bytes(b"untrusted replacement")
                self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=token), "pack changed")
                self.assertEqual(prepared.read_bytes(), b"untrusted replacement")
                self.assert_old_checkout(target, before)

    def test_git_interruption_retains_ref_index_file_preimages(self):
        target, before, candidate, token = self.prepared_git_update()
        class Interrupt(BaseException):
            pass
        class Crash(self.backend):
            def _git_point(inner, point):
                if point == "ref":
                    raise Interrupt()
            def _rollback(inner, original):
                raise Interrupt()
        with self.assertRaises(Interrupt):
            self.run_request("update", backend=Crash, **before, targetCommit=candidate, stageToken=token)
        journal = json.loads((self.state / "transaction.json").read_text())
        work = self.state / journal["workspace"]
        self.assertEqual((work / "backup-git/fixture/refs/heads/main").read_text().strip(), before["expectedCommit"])
        self.assertEqual((work / "backup-git/fixture/index").read_bytes()[:4], b"DIRC")
        self.assertEqual((work / "backup/fixture/main.js").read_text(), "export default {};\n")
        self.assertEqual(self.live_git(target, "rev-parse", "HEAD"), candidate)
        self.assertEqual((target / "main.js").read_text(), "export default {};\n")
        self.assertTrue(self.discover()["migration"]["blocked"])
        self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=token), "Interrupted transaction")

    def test_git_external_index_edit_is_retained_with_blocking_journal(self):
        target, before, candidate, token = self.prepared_git_update()
        class Conflict(self.backend):
            def _git_point(inner, point):
                if point == "index":
                    (target / ".git/index").write_bytes(b"external index edit")
                    raise OSError("index conflict")
        self.bad(self.run_request("update", backend=Conflict, **before, targetCommit=candidate, stageToken=token), "Rollback could not be verified")
        journal = json.loads((self.state / "transaction.json").read_text())
        work = self.state / journal["workspace"]
        self.assertTrue(any(p.is_file() and p.read_bytes() == b"external index edit" for p in work.rglob("*")))
        self.assertEqual((work / "original-index").read_bytes()[:4], b"DIRC")
        self.assertTrue(self.discover()["migration"]["blocked"])

    def test_linked_checkout_ancestor_after_prepare_never_writes_outside(self):
        target, before, candidate, token = self.prepared_git_update()
        detached = self.base / "detached-checkout"
        target.rename(detached)
        target.symlink_to(detached, target_is_directory=True)
        original = (detached / "main.js").read_bytes()
        self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=token))
        self.assertEqual((detached / "main.js").read_bytes(), original)
        self.assertEqual(self.live_git(detached, "rev-parse", "HEAD"), before["expectedCommit"])
        self.assertTrue(target.is_symlink())

    def test_missing_legacy_git_preimage_is_not_silently_ignored(self):
        target = self.legacy_git()
        (target / ".git/HEAD").unlink()
        before = self.tree()
        summary = self.discover()["migration"]
        self.assertTrue(summary["blocked"], summary)
        self.bad(self.run_request("migrate", migrationToken=summary["token"]))
        self.assertEqual(before, self.tree())

    def test_hidden_git_index_flags_block_migration_and_update(self):
        target = self.legacy_git()
        self.live_git(target, "update-index", "--assume-unchanged", "main.js")
        self.assertTrue(self.discover()["migration"]["blocked"])
        self.live_git(target, "update-index", "--no-assume-unchanged", "main.js")
        self.migrate()
        before = self.confirmation()
        self.live_git(target, "update-index", "--skip-worktree", "main.js")
        self.bad(self.run_request("check-update", id="fixture"), "flags")
        archive = self.discover()["mods"][0]["archivePath"]
        self.bad(self.run_request("uninstall", **before, archiveGit=True, archivePath=archive), "flags")

    def test_git_index_tampering_after_ref_is_not_adopted(self):
        target, before, candidate, token = self.prepared_git_update()
        prepared = self.state / ("work-" + token) / "git-prepared/index"
        class Tamper(self.backend):
            def _git_point(inner, point):
                if point == "ref":
                    prepared.write_bytes(b"late index tampering")
        self.bad(self.run_request("update", backend=Tamper, **before, targetCommit=candidate, stageToken=token), "payload changed")
        self.assert_old_checkout(target, before)
        self.assertEqual(prepared.read_bytes(), b"late index tampering")

    def test_git_payload_file_read_is_bound_to_verified_receipt(self):
        target, before, candidate, token = self.prepared_git_update()
        prepared = self.state / ("work-" + token) / "git-prepared/objects.pack"
        class Tamper(self.backend):
            def _git_begin(inner, *args):
                prepared.write_bytes(b"late pack tampering")
                return super()._git_begin(*args)
        self.bad(self.run_request("update", backend=Tamper, **before, targetCommit=candidate, stageToken=token), "payload changed")
        self.assert_old_checkout(target, before)
        self.assertEqual(prepared.read_bytes(), b"late pack tampering")

    def test_migration_journal_cannot_redefine_ownership_or_completion(self):
        self.legacy_package()
        class Crash(self.backend):
            def _migration_point(inner, point):
                if point == "intent":
                    raise OSError("intent interruption")
        summary = self.discover()["migration"]
        self.bad(self.run_request("migrate", backend=Crash, migrationToken=summary["token"]))
        journal_path = self.state / "migration.json"
        original = journal_path.read_bytes()
        original_registry = (self.state / "registry.json").read_bytes()
        cases = ("remove-targets", "remove-records", "repository", "path", "kind", "history", "phase", "token", "preimages", "workspace", "remove-field")
        for case in cases:
            with self.subTest(case=case):
                journal = json.loads(original)
                record = journal["registry"]["mods"]["fixture"]
                if case == "remove-targets":
                    journal["targets"] = []
                elif case == "remove-records":
                    journal["registry"]["mods"] = {}
                    journal["targets"] = []
                elif case == "repository":
                    record["repository"] = "attacker/fixture"
                    journal["targets"][0]["repository"] = "attacker/fixture"
                elif case == "path":
                    record["path"] += "-other"
                    journal["targets"][0]["path"] = record["path"]
                elif case == "kind":
                    record["kind"] = "git"
                    journal["targets"][0]["kind"] = "git"
                elif case == "history":
                    journal["registry"]["history"].append(record.copy())
                elif case == "phase":
                    journal["phase"] = "complete"
                elif case == "token":
                    journal["token"] = "0" * 64
                elif case == "preimages":
                    journal["preimages"]["registry.json"] = None
                elif case == "workspace":
                    journal["workspace"] = "migration-" + "0" * 32
                else:
                    journal.pop("backup")
                journal_path.write_bytes(operations.encode(journal))
                before = self.tree()
                rejected = self.discover()["migration"]
                self.assertTrue(rejected["blocked"], rejected)
                self.bad(self.run_request("migrate", migrationToken=rejected["token"]))
                self.assertEqual(before, self.tree())
                self.assertEqual((self.state / "registry.json").read_bytes(), original_registry)
        journal_path.write_bytes(original)
        self.migrate()
        self.assertTrue(self.discover(runtimeKnown=True)["mods"][0]["managed"])

    def test_migration_manifest_edit_and_same_bytes_inode_swap_block(self):
        self.legacy_package()
        class Crash(self.backend):
            def _migration_point(inner, point):
                if point == "intent":
                    raise OSError("intent interruption")
        summary = self.discover()["migration"]
        self.bad(self.run_request("migrate", backend=Crash, migrationToken=summary["token"]))
        journal = json.loads((self.state / "migration.json").read_text())
        manifest = self.state / journal["workspace"] / "intent.json"
        original = manifest.read_bytes()
        manifest.write_bytes(b"{}\n")
        self.assertTrue(self.discover()["migration"]["blocked"])
        manifest.write_bytes(original)
        replacement = manifest.with_name("replacement")
        replacement.write_bytes(original)
        replacement.replace(manifest)
        before = self.tree()
        rejected = self.discover()["migration"]
        self.assertTrue(rejected["blocked"])
        self.bad(self.run_request("migrate", migrationToken=rejected["token"]))
        self.assertEqual(before, self.tree())

    def test_pre_intent_interruption_retains_preimages_without_lock_handover(self):
        self.legacy_package()
        original_lock = (self.state / "lock").read_bytes()
        original_registry = (self.state / "registry.json").read_bytes()
        class Crash(self.backend):
            def _migration_point(inner, point):
                if point == "manifest":
                    raise OSError("manifest interruption")
        summary = self.discover()["migration"]
        self.bad(self.run_request("migrate", backend=Crash, migrationToken=summary["token"]))
        self.assertFalse((self.state / "migration.json").exists())
        self.assertEqual((self.state / "lock").read_bytes(), original_lock)
        self.assertEqual((self.state / "registry.json").read_bytes(), original_registry)
        self.assertTrue(list(self.state.glob("migration-*/intent.json")))
        self.assertTrue(list(self.state.glob("migration-receipt-*.json")))
        self.migrate()
        self.assertTrue(list(self.state.glob("migration-*/registry.json")))

    def assert_metadata_swap_does_not_write_outside(self, relative, point):
        target, before, candidate, token = self.prepared_git_update()
        # Put the source branch at OLD while retaining the prepared target
        # objects. An unsafe writer can now reproduce the outside-ref bug.
        self.git("update-ref", "refs/heads/main", before["expectedCommit"], candidate)
        owned = target / ".git"
        if relative:
            owned /= relative
        outside = self.repo / ".git"
        if relative:
            outside /= relative
        before_files = {str(p.relative_to(outside)): (p.read_bytes(), operations.identity(p.stat())) for p in outside.rglob("*") if p.is_file()}
        detached = self.base / "detached-owned-git-metadata"
        class Swap(self.backend):
            fired = False
            def _git_point(inner, reached):
                if reached == point and not inner.fired:
                    inner.fired = True
                    owned.rename(detached)
                    owned.symlink_to(outside, target_is_directory=True)
        self.bad(self.run_request("update", backend=Swap, **before, targetCommit=candidate, stageToken=token))
        after_files = {str(p.relative_to(outside)): (p.read_bytes(), operations.identity(p.stat())) for p in outside.rglob("*") if p.is_file()}
        self.assertEqual(before_files, after_files)
        self.assertTrue(owned.is_symlink())
        self.assertTrue((self.state / "transaction.json").exists())
        self.assertEqual((target / "main.js").read_text(), "export default {};\n")

    def test_git_directory_swap_before_ref_never_writes_outside(self):
        self.assert_metadata_swap_does_not_write_outside("", "before-ref")

    def test_git_nested_refs_swap_before_ref_never_writes_outside(self):
        self.assert_metadata_swap_does_not_write_outside("refs/heads", "before-ref")

    def test_git_objects_swap_before_publication_never_writes_outside(self):
        self.assert_metadata_swap_does_not_write_outside("objects", "before-objects")

    def test_git_nested_pack_swap_never_writes_outside(self):
        self.assert_metadata_swap_does_not_write_outside("objects/pack", "before-objects")

    def test_no_git_writer_runs_against_live_checkout(self):
        target, before, candidate, token = self.prepared_git_update()
        root_inode = operations.identity(target.stat())
        class NoLiveWriter(self.backend):
            def _git(inner, arguments, cwd_fd, *args, **kwargs):
                if operations.identity(os.fstat(cwd_fd)) == root_inode:
                    self.assertNotIn(arguments[0], {"index-pack", "update-ref", "read-tree", "fetch", "merge", "reset", "clean", "stash"})
                return super()._git(arguments, cwd_fd, *args, **kwargs)
        self.good(self.run_request("update", backend=NoLiveWriter, **before, targetCommit=candidate, stageToken=token))
        self.assertEqual(self.live_git(target, "rev-parse", "HEAD"), candidate)

    def test_native_ref_and_index_locks_are_not_removed_or_bypassed(self):
        target, before, candidate, token = self.prepared_git_update()
        for name, point in (("refs/heads/main.lock", "before-ref"), ("index.lock", "files")):
            with self.subTest(name=name):
                lock = target / ".git" / name
                class Writer(self.backend):
                    def _git_point(inner, reached):
                        if reached == point:
                            lock.write_bytes(b"external native Git lock")
                self.bad(self.run_request("update", backend=Writer, **before, targetCommit=candidate, stageToken=token))
                self.assertEqual(lock.read_bytes(), b"external native Git lock")
                self.assertTrue((self.state / "transaction.json").exists())
                # This fixture deliberately remains blocked. Test the second
                # native lock in a new disposable profile, not by deleting it.
                if name == "refs/heads/main.lock":
                    self.tearDown()
                    self.setUp()
                    target, before, candidate, token = self.prepared_git_update()

    def test_packed_slash_branch_recreates_missing_ref_parent_safely(self):
        self.git("checkout", "-b", "release/stable")
        target = self.legacy_git(branch="release/stable")
        self.live_git(target, "pack-refs", "--all", "--prune")
        parent = target / ".git/refs/heads/release"
        if parent.exists():
            parent.rmdir()
        self.migrate()
        before = self.confirmation()
        root_inode, git_inode = target.stat().st_ino, (target / ".git").stat().st_ino
        self.write_mod(text="export default {packed:true};\n")
        candidate = self.commit()
        self.assertEqual(self.good(self.run_request("check-update", id="fixture"))["updateCommit"], candidate)
        self.good(self.run_request("update", **before, targetCommit=candidate))
        self.assertEqual(self.live_git(target, "rev-parse", "HEAD"), candidate)
        self.assertEqual(self.live_git(target, "status", "--porcelain=v1"), "")
        self.assertEqual(target.stat().st_ino, root_inode)
        self.assertEqual((target / ".git").stat().st_ino, git_inode)
        self.assertTrue((target / ".git/refs/heads/release/stable").is_file())
        self.assertTrue((target / ".git/packed-refs").is_file())

    def test_tracked_git_placeholder_does_not_hide_legacy_marker(self):
        (self.repo / ".git-placeholder").write_bytes(b"ordinary tracked package data")
        self.commit()
        target = self.legacy_git()
        before = self.tree()
        summary = self.discover()["migration"]
        self.assertTrue(summary["required"], summary)
        self.assertFalse(summary["blocked"], summary)
        self.migrate()
        self.assertEqual((target / ".git-placeholder").read_bytes(), b"ordinary tracked package data")
        for path, data in before.items():
            if path.startswith("mods/"):
                self.assertEqual(self.tree()[path], data)
        self.assertEqual(self.discover(runtimeKnown=True)["mods"][0]["kind"], "git")

    def test_native_publication_preserves_private_git_metadata_permissions(self):
        target = self.legacy_git()
        (target / ".git/index").chmod(0o600)
        (target / ".git/refs/heads/main").chmod(0o600)
        self.migrate()
        before = self.confirmation()
        self.write_mod(text="export default {private:true};\n")
        candidate = self.commit()
        self.good(self.run_request("update", **before, targetCommit=candidate))
        self.assertEqual((target / ".git/index").stat().st_mode & 0o777, 0o600)
        self.assertEqual((target / ".git/refs/heads/main").stat().st_mode & 0o777, 0o600)
        self.assertNotIn("protectedReason", self.discover(runtimeKnown=True)["mods"][0])

    def test_git_ref_parent_swap_after_pin_never_writes_outside(self):
        target, before, candidate, token = self.prepared_git_update()
        self.git("update-ref", "refs/heads/main", before["expectedCommit"], candidate)
        outside = self.repo / ".git/refs/heads"
        outside_before = {p.name: (p.read_bytes(), operations.identity(p.stat())) for p in outside.iterdir() if p.is_file()}
        real_rename = operations.rename_exclusive
        fired = []
        def swap(source_fd, source, target_fd, destination):
            if source == "main.lock" and destination == "main" and not fired:
                fired.append(True)
                owned = target / ".git/refs/heads"
                owned.rename(self.base / "detached-pinned-heads")
                owned.symlink_to(outside, target_is_directory=True)
            return real_rename(source_fd, source, target_fd, destination)
        with mock.patch.object(operations, "rename_exclusive", side_effect=swap):
            self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=token))
        self.assertTrue(fired)
        self.assertEqual({p.name: (p.read_bytes(), operations.identity(p.stat())) for p in outside.iterdir() if p.is_file()}, outside_before)
        self.assertTrue((self.state / "transaction.json").exists())

    def test_git_object_parent_swap_after_pin_never_writes_outside(self):
        target, before, candidate, token = self.prepared_git_update()
        outside = self.base / "outside-object-pack"
        outside.mkdir()
        (outside / "sentinel").write_bytes(b"outside data")
        inode = (outside / "sentinel").stat().st_ino
        real_rename = operations.rename_exclusive
        fired = []
        def swap(source_fd, source, target_fd, destination):
            if source.startswith("git-object-") and destination.endswith(".pack") and not fired:
                fired.append(True)
                owned = target / ".git/objects/pack"
                owned.rename(self.base / "detached-pinned-pack")
                owned.symlink_to(outside, target_is_directory=True)
            return real_rename(source_fd, source, target_fd, destination)
        with mock.patch.object(operations, "rename_exclusive", side_effect=swap):
            self.bad(self.run_request("update", **before, targetCommit=candidate, stageToken=token))
        self.assertTrue(fired)
        self.assertEqual(list(outside.iterdir()), [outside / "sentinel"])
        self.assertEqual((outside / "sentinel").read_bytes(), b"outside data")
        self.assertEqual((outside / "sentinel").stat().st_ino, inode)
        self.assertTrue((self.state / "transaction.json").exists())

    def test_new_git_metadata_during_commit_is_preserved_not_adopted(self):
        target, before, candidate, token = self.prepared_git_update()
        external_ref = target / ".git/refs/heads/external-writer"
        value = (before["expectedCommit"] + "\n").encode()
        class Writer(self.backend):
            def _git_point(inner, point):
                if point == "index":
                    external_ref.write_bytes(value)
        self.bad(self.run_request("update", backend=Writer, **before, targetCommit=candidate, stageToken=token), "Rollback could not be verified")
        self.assertEqual(external_ref.read_bytes(), value)
        self.assertTrue((self.state / "transaction.json").exists())
        record = json.loads((self.state / "registry.json").read_text())["mods"]["fixture"]
        self.assertNotIn("refs/heads/external-writer", record["git"]["files"])

    def test_git_permission_edit_during_rollback_is_retained(self):
        target, before, candidate, token = self.prepared_git_update()
        index = target / ".git/index"
        class Writer(self.backend):
            def _git_point(inner, point):
                if point == "index":
                    index.chmod(0o600)
                    raise OSError("external index permission edit")
        self.bad(self.run_request("update", backend=Writer, **before, targetCommit=candidate, stageToken=token), "Rollback could not be verified")
        journal = json.loads((self.state / "transaction.json").read_text())
        work = self.state / journal["workspace"]
        self.assertTrue(any(p.is_file() and p.name.startswith("git-retired-") and p.read_bytes()[:4] == b"DIRC" and p.stat().st_mode & 0o777 == 0o600 for p in work.iterdir()))
        self.assertTrue((work / "original-index").is_file())

    def test_packed_ref_change_before_native_lock_stops_before_live_files(self):
        target = self.legacy_git()
        self.live_git(target, "pack-refs", "--all", "--prune")
        self.migrate()
        before = self.confirmation()
        self.write_mod(text="export default {v:2};\n")
        candidate = self.commit()
        token = self.good(self.run_request("prepare-update", **before, targetCommit=candidate))["stageToken"]
        packed = target / ".git/packed-refs"
        changed = packed.read_bytes().replace(
            (before["expectedCommit"] + " refs/heads/main\n").encode(),
            (candidate + " refs/heads/main\n").encode(),
        )
        points = set()
        class Writer(self.backend):
            def _git_point(inner, point):
                if point == "before-ref":
                    replacement = target / ".git/packed-refs.edit"
                    replacement.write_bytes(changed)
                    replacement.chmod(packed.stat().st_mode & 0o777)
                    os.replace(replacement, packed)
                    points.add(point)
                elif point == "files":
                    points.add(point)
        self.bad(self.run_request("update", backend=Writer, **before, targetCommit=candidate, stageToken=token))
        self.assertIn("before-ref", points)
        self.assertNotIn("files", points)
        self.assertEqual(packed.read_bytes(), changed)
        self.assertTrue((self.state / "transaction.json").exists())

    def test_git_archive_failure_restores_entire_checkout(self):
        target = self.legacy_git()
        self.migrate()
        before = self.confirmation()
        archive = self.discover()["mods"][0]["archivePath"]
        inode = target.stat().st_ino
        class Failure(self.backend):
            def _git_point(inner, point):
                if point == "archive":
                    raise OSError("archive fault")
        self.bad(self.run_request("uninstall", backend=Failure, **before, archiveGit=True, archivePath=archive), "archive fault")
        self.assertTrue(target.is_dir())
        self.assertEqual(target.stat().st_ino, inode)
        self.assertFalse(Path(archive).exists())
        self.assertFalse((self.state / "transaction.json").exists())


if __name__ == "__main__":
    unittest.main()
