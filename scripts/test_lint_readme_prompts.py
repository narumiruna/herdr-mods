"""Tests for Herdr installation prompts in mod READMEs."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from lint_readme_prompts import has_install_prompt
from lint_readme_prompts import lint_repository

SCRIPT = Path(__file__).with_name("lint_readme_prompts.py").resolve()
MOD_URL = "https://github.com/narumiruna/herdr-mods/tree/main/mods/example"
PROMPT = f"Read ~/.config/herdr-app/AGENTS.md, then add this mod: {MOD_URL}"
TEXT_FENCE = "```"


def fenced_prompt(prompt: str = PROMPT) -> str:
    return f"{TEXT_FENCE}text\n{prompt}\n{TEXT_FENCE}\n"


class InstallPromptTests(unittest.TestCase):
    def test_accepts_prompt_in_plain_text_fences(self):
        wrapped = PROMPT.replace(f" {MOD_URL}", f"\n{MOD_URL}")
        for fence, label, prompt in (
            (TEXT_FENCE, "", PROMPT),
            (TEXT_FENCE, "text", PROMPT),
            ("~~~~", "plaintext", wrapped),
        ):
            with self.subTest(fence=fence, label=label):
                source = f"# Example\n\n{fence}{label}\n{prompt}\n{fence}\n"
                self.assertTrue(has_install_prompt(source, "example"))

    def test_rejects_plain_prose_comments_and_nested_examples(self):
        prompt = fenced_prompt()
        outer_fence = TEXT_FENCE + "`"
        rejected = (
            PROMPT,
            f"<!--\n{prompt}-->\n",
            f"{outer_fence}markdown\n{prompt}{outer_fence}\n",
            "\n".join(f"> {line}" for line in prompt.splitlines()),
        )
        for source in rejected:
            with self.subTest(source=source):
                self.assertFalse(has_install_prompt(source, "example"))

    def test_recognizes_a_fence_after_comments_and_other_code(self):
        source = (
            f"{TEXT_FENCE}xml\n<!-- unclosed in code\n{TEXT_FENCE}\n\n"
            f"<!-- an actual comment -->\n\n{fenced_prompt()}"
        )
        self.assertTrue(has_install_prompt(source, "example"))

    def test_requires_the_correct_mod_url(self):
        for url in (
            MOD_URL.replace("/mods/example", "/mods/<name>"),
            MOD_URL.replace("/mods/example", "/mods/another-mod"),
            MOD_URL.replace("/tree/main/", "/tree/dev/"),
            MOD_URL.removesuffix("/tree/main/mods/example"),
            MOD_URL.replace("/narumiruna/", "/someone-else/"),
        ):
            with self.subTest(url=url):
                source = fenced_prompt(PROMPT.replace(MOD_URL, url))
                self.assertFalse(has_install_prompt(source, "example"))

    def test_rejects_incomplete_or_non_text_block(self):
        without_url = PROMPT.removesuffix(f" {MOD_URL}")
        for source in (
            f"{MOD_URL}\n\n{fenced_prompt(without_url)}",
            fenced_prompt().removesuffix(f"{TEXT_FENCE}\n"),
            fenced_prompt().replace(f"{TEXT_FENCE}text", f"{TEXT_FENCE}sh"),
        ):
            with self.subTest(source=source):
                self.assertFalse(has_install_prompt(source, "example"))


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def make_mod(self, name: str, entry: str = "mod.json") -> Path:
        mod = self.root / "mods" / name
        mod.mkdir(parents=True)
        (mod / entry).touch()
        return mod

    def test_checks_all_mods_but_not_generated_folders(self):
        self.make_mod("zeta")
        self.make_mod("alpha", entry="main.js")
        cache = self.root / "mods" / "retired-mod"
        cache.mkdir()
        (cache / "gpui-kit.d.ts").touch()
        errors = lint_repository(self.root)
        self.assertEqual(
            errors,
            [
                "mods/alpha/README.md: missing README.md",
                "mods/zeta/README.md: missing README.md",
            ],
        )

    def test_rejects_invalid_utf8(self):
        mod = self.make_mod("example")
        (mod / "README.md").write_bytes(b"\xff")
        self.assertIn("cannot read UTF-8 README", lint_repository(self.root)[0])

    def test_cli_reports_success_and_failure(self):
        mod = self.make_mod("example")
        readme = mod / "README.md"
        readme.write_text(fenced_prompt(), encoding="utf-8")
        for expected in (0, 1):
            with self.subTest(expected=expected):
                result = subprocess.run(
                    [sys.executable, str(SCRIPT)],
                    cwd=self.root,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, expected, result.stderr)
                if expected == 0:
                    self.assertIn("PASS", result.stdout)
                    readme.write_text(PROMPT, encoding="utf-8")
                else:
                    self.assertIn("mods/example/README.md", result.stderr)

    def test_no_mods_is_an_error(self):
        (self.root / "mods").mkdir()
        self.assertIn("no mod directories found", lint_repository(self.root)[0])


if __name__ == "__main__":
    unittest.main()
