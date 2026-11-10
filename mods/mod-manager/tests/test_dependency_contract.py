"""Native Herdr key/layout references, not arbitrary display text, protect targets."""
import json
import unittest

import test_operations as operation_fixtures


class DependencyContractTests(unittest.TestCase):
    def setUp(self):
        self.fixture = operation_fixtures.LifecycleTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.fixture.install()
        self.confirmation = self.fixture.confirmation()

    def protected(self, filename, value):
        (self.fixture.home / filename).write_text(json.dumps(value))
        result = self.fixture.run_request("uninstall", **self.confirmation)
        self.assertFalse(result["ok"], result)
        self.assertTrue((self.fixture.home / "mods/fixture/main.js").exists())

    def test_mod_open_object_uses_the_installed_api_name_argument(self):
        self.protected("keys.json", {"global": {"ctrl-m": {"command": "mod.open", "args": {"name": "fixture"}}}})

    def test_mod_open_string_binding_protects_the_named_mod(self):
        self.protected("keys.json", {"global": {"ctrl-m": "mod.open:fixture"}})

    def test_custom_mod_command_string_binding_protects_the_recipient(self):
        self.protected("keys.json", {"global": {"ctrl-r": "fixture.refresh"}})

    def test_custom_mod_command_object_binding_protects_the_recipient(self):
        self.protected("keys.json", {"global": {"ctrl-r": {"command": "fixture.refresh"}}})

    def test_mod_clone_reference_protects_the_source_name(self):
        self.protected("keys.json", {"global": {"ctrl-d": {"command": "mod.clone", "args": {"name": "fixture", "as": "personal-copy"}}}})

    def test_layout_menu_reference_is_a_real_dependency(self):
        self.protected("settings.json", {"terminal_menu": "fixture"})

    def test_toast_reference_is_a_real_dependency(self):
        self.protected("settings.json", {"toast_mod": "fixture"})

    def test_unrelated_theme_and_description_are_not_mod_references(self):
        (self.fixture.home / "settings.json").write_text(json.dumps({"theme": "fixture", "description": "fixture.refresh", "title": "mod.open:fixture"}))
        result = self.fixture.run_request("uninstall", **self.confirmation)
        self.assertTrue(result["ok"], result)
