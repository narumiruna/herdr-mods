"""Tests use disposable directories and do not change the installed Herdr profile."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lint_recipes import lint_repository


SCRIPT = Path(__file__).with_name("lint_recipes.py").resolve()
SECTIONS = ("What you see", "How it behaves", "Built from", "Watch out", "Done when")
RECIPE = "# Example\n\nA build brief.\n\n" + "".join(
    f"## {section}\n\nFixture content.\n\n" for section in SECTIONS
)


class RecipeLintTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="herdr-recipe-lint-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def mod(self, name="example", recipe=RECIPE):
        mod = self.root / "mods" / name
        mod.mkdir(parents=True)
        if recipe is not None:
            (mod / "RECIPE.md").write_text(recipe, encoding="utf-8")
        # File presence only. This fixture is not an image or a gallery preview.
        (mod / "preview.png").touch()
        return mod

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *map(str, args)],
            cwd=self.root, capture_output=True, text=True, check=False,
        )

    def test_monorepo_does_not_require_root_recipe(self):
        self.mod("alpha")
        self.mod("beta")
        self.assertEqual(lint_repository(self.root), [])

    def test_standalone_root_recipe_does_not_require_mods_or_preview(self):
        (self.root / "RECIPE.md").write_text(RECIPE, encoding="utf-8")
        self.assertEqual(lint_repository(self.root), [])

    def test_checks_optional_root_recipe_when_present(self):
        self.mod()
        (self.root / "RECIPE.md").write_text("# Root\n", encoding="utf-8")
        self.assertEqual(
            lint_repository(self.root),
            [f"RECIPE.md: missing section: ## {section}" for section in SECTIONS],
        )

    def test_root_recipe_does_not_replace_mod_recipes(self):
        (self.root / "RECIPE.md").write_text(RECIPE, encoding="utf-8")
        self.mod(recipe=None)
        self.assertEqual(lint_repository(self.root), [
            "mods/example/RECIPE.md: required file is missing or is not a file",
        ])

    def test_reports_missing_files_for_all_mods_in_name_order(self):
        for name in ("zeta", "alpha"):
            mod = self.mod(name, recipe=None)
            (mod / "preview.png").unlink()
        self.assertEqual(lint_repository(self.root), [
            "mods/alpha/preview.png: required file is missing or is not a file",
            "mods/zeta/preview.png: required file is missing or is not a file",
            "mods/alpha/RECIPE.md: required file is missing or is not a file",
            "mods/zeta/RECIPE.md: required file is missing or is not a file",
        ])

    def test_preview_is_required_even_when_recipe_is_valid(self):
        (self.mod() / "preview.png").unlink()
        self.assertEqual(lint_repository(self.root), [
            "mods/example/preview.png: required file is missing or is not a file",
        ])

    def test_directories_do_not_count_as_required_files(self):
        mod = self.mod(recipe=None)
        (mod / "RECIPE.md").mkdir()
        (mod / "preview.png").unlink()
        (mod / "preview.png").mkdir()
        self.assertEqual(len(lint_repository(self.root)), 2)

    def test_requires_each_exact_h2_section(self):
        mod = self.mod()
        for section in SECTIONS:
            for replacement in ("", f"### {section}", f"## {section} details", section):
                with self.subTest(section=section, replacement=replacement):
                    (mod / "RECIPE.md").write_text(
                        RECIPE.replace(f"## {section}", replacement), encoding="utf-8",
                    )
                    self.assertEqual(lint_repository(self.root), [
                        f"mods/example/RECIPE.md: missing section: ## {section}",
                    ])

    def test_requires_non_empty_h1_title(self):
        mod = self.mod()
        for title in ("", "#", "#   ", "# ###", "## Example", "    # Example"):
            with self.subTest(title=title):
                (mod / "RECIPE.md").write_text(
                    RECIPE.replace("# Example", title), encoding="utf-8",
                )
                self.assertEqual(lint_repository(self.root), [
                    "mods/example/RECIPE.md: missing non-empty H1 title (# Name)",
                ])

    def test_accepts_heading_whitespace_and_optional_closing_hashes(self):
        self.mod(recipe="# Example ###\n" + "".join(
            f"   ##\t{section} ###  \n" for section in SECTIONS
        ))
        self.assertEqual(lint_repository(self.root), [])

    def test_indented_code_and_heading_substrings_do_not_count(self):
        self.mod(recipe="# Example\n" + "".join(
            f"    ## {section}\nText ## {section}\n" for section in SECTIONS
        ))
        self.assertEqual(len(lint_repository(self.root)), 5)

    def test_ignores_fenced_code_blocks(self):
        mod = self.mod()
        for opening, closing in (
            ("```markdown", "```"),
            ("~~~markdown", "~~~"),
            ("````markdown", "```\n~~~\n````"),
            ("~~~markdown", "~~~~"),
        ):
            with self.subTest(opening=opening, closing=closing):
                (mod / "RECIPE.md").write_text(
                    f"{opening}\n{RECIPE}{closing}\n", encoding="utf-8",
                )
                self.assertEqual(len(lint_repository(self.root)), 6)

    def test_recognizes_headings_after_a_closed_fence(self):
        self.mod(recipe="```markdown\n<!-- This is code, not a comment.\n```\n" + RECIPE)
        self.assertEqual(lint_repository(self.root), [])

    def test_ignores_html_comments_and_resumes_after_them(self):
        mod = self.mod(recipe=f"<!--\n{RECIPE}-->\n")
        self.assertEqual(len(lint_repository(self.root)), 6)
        (mod / "RECIPE.md").write_text(
            "<!--\n```\n-->\n<!-- One-line comment. -->\n" + RECIPE,
            encoding="utf-8",
        )
        self.assertEqual(lint_repository(self.root), [])

    def test_accepts_utf8_bom_crlf_and_unicode(self):
        mod = self.mod()
        source = RECIPE.replace("Example", "Example 測試").replace("\n", "\r\n")
        (mod / "RECIPE.md").write_bytes(source.encode("utf-8-sig"))
        self.assertEqual(lint_repository(self.root), [])

    def test_reports_invalid_utf8(self):
        (self.mod() / "RECIPE.md").write_bytes(b"\xff\xfe")
        errors = lint_repository(self.root)
        self.assertEqual(len(errors), 1)
        self.assertIn("mods/example/RECIPE.md: cannot read UTF-8 recipe:", errors[0])

    def test_reports_unreadable_recipe_without_a_traceback(self):
        self.mod()
        with patch.object(Path, "read_text", side_effect=PermissionError("fixture denied")):
            self.assertEqual(lint_repository(self.root), [
                "mods/example/RECIPE.md: cannot read UTF-8 recipe: fixture denied",
            ])

    def test_only_checks_immediate_mod_directories(self):
        mod = self.mod()
        (self.root / "mods" / "notes.txt").touch()
        (mod / "nested").mkdir()
        (mod / "nested" / "RECIPE.md").write_text("Not a recipe", encoding="utf-8")
        self.assertEqual(lint_repository(self.root), [])

    def test_no_targets_is_an_error(self):
        expected = ["no recipe targets found; expected RECIPE.md or mods/*/RECIPE.md"]
        self.assertEqual(lint_repository(self.root), expected)
        (self.root / "mods").mkdir()
        self.assertEqual(lint_repository(self.root), expected)

    def test_mods_must_be_a_directory(self):
        (self.root / "mods").touch()
        self.assertEqual(lint_repository(self.root), ["mods: expected a directory"])

    def test_rejects_missing_or_non_directory_root(self):
        missing = self.root / "missing"
        file = self.root / "file"
        file.touch()
        for root in (missing, file):
            with self.subTest(root=root):
                self.assertEqual(lint_repository(root), [
                    f"{root}: expected an existing directory",
                ])

    def test_ignores_list_contained_fences(self):
        mod = self.mod()
        for marker in ("- ", "1. "):
            with self.subTest(marker=marker):
                indentation = " " * len(marker)
                code = "".join(indentation + line + "\n" for line in RECIPE.splitlines())
                (mod / "RECIPE.md").write_text(
                    marker + "```markdown\n" + code + indentation + "```\n",
                    encoding="utf-8",
                )
                self.assertEqual(len(lint_repository(self.root)), 6)

    def test_list_dedent_does_not_hide_real_headings(self):
        self.mod(recipe="- ```markdown\n  Code without a closing fence.\n\n" + RECIPE)
        self.assertEqual(lint_repository(self.root), [])

    def test_ignores_raw_html_blocks(self):
        mod = self.mod()
        for tag in ("pre", "script", "style", "textarea", "div"):
            with self.subTest(tag=tag):
                content = RECIPE.replace("\n\n", "\n") if tag == "div" else RECIPE
                (mod / "RECIPE.md").write_text(
                    f"<{tag}>\n{content}</{tag}>\n", encoding="utf-8",
                )
                self.assertEqual(len(lint_repository(self.root)), 6)

    def test_comments_cannot_create_heading_markers(self):
        mod = self.mod()
        for comment in ("<!-- Note -->", "<!--\n-->"):
            with self.subTest(comment=comment):
                source = "# Example\n" + "".join(
                    f"{comment}## {section}\n" for section in SECTIONS
                )
                (mod / "RECIPE.md").write_text(source, encoding="utf-8")
                self.assertEqual(len(lint_repository(self.root)), 5)

    def test_comment_markers_in_fence_info_or_code_spans_are_literal(self):
        mod = self.mod()
        for source in (
            "```text <!--\nCode.\n```\n" + RECIPE,
            RECIPE.replace("A build brief.", "A build brief with `<!--` and ``<!--``."),
        ):
            with self.subTest(source=source):
                (mod / "RECIPE.md").write_text(source, encoding="utf-8")
                self.assertEqual(lint_repository(self.root), [])

    def test_tracks_a_new_comment_after_a_multiline_comment_closes(self):
        self.mod(recipe="<!--\n--> <!--\n" + RECIPE + "-->\n")
        self.assertEqual(len(lint_repository(self.root)), 6)

    def test_cli_defaults_to_current_directory(self):
        self.mod()
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS:", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_cli_accepts_an_explicit_repository_directory(self):
        repository = self.root / "other-repository"
        repository.mkdir()
        (repository / "RECIPE.md").write_text(RECIPE, encoding="utf-8")
        result = self.cli(repository)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cli_reports_all_errors_and_returns_one(self):
        self.mod("alpha", recipe=None)
        (self.mod("beta") / "preview.png").unlink()
        result = self.cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("mods/alpha/RECIPE.md:", result.stderr)
        self.assertIn("mods/beta/preview.png:", result.stderr)
        self.assertIn("FAIL: 2 recipe error(s).", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
