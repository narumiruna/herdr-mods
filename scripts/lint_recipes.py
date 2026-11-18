#!/usr/bin/env python3
"""Check recipe files and required Markdown headings with the standard library."""

import argparse
import re
import sys
from pathlib import Path


REQUIRED_SECTIONS = (
    "What you see",
    "How it behaves",
    "Built from",
    "Watch out",
    "Done when",
)


def markdown_headings(source: str):
    """Read ATX headings, excluding code blocks, HTML blocks, and comments."""
    fence = None
    html_end = None
    in_comment = False
    for line in source.splitlines():
        if html_end:
            if html_end.search(line):
                html_end = None
            continue
        if fence:
            ticks, indentation = fence
            # A dedent ends a list-contained code block, even without a closing fence.
            if not indentation or not line.strip() or line.startswith(" " * indentation):
                if re.fullmatch(
                    rf" {{0,{indentation + 3}}}{re.escape(ticks[0])}{{{len(ticks)},}}[ \t]*",
                    line,
                ):
                    fence = None
                continue
            fence = None
        if in_comment:
            _, end, remainder = line.partition("-->")
            if end:
                in_comment = "<!--" in re.sub(r"<!--.*?-->", "", remainder)
            continue
        opening = re.fullmatch(
            r"( {0,3})((?:(?:[-+*]|[0-9]{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})(.*)", line,
        )
        if opening and not (opening[3][0] == "`" and "`" in opening[4]):
            indentation = len((opening[1] + opening[2]).expandtabs(4)) if opening[2] else 0
            fence = opening[3], indentation
            continue
        html = re.match(r" {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)", line, re.I)
        if html:
            closing = re.compile(rf"</{html[1]}[ \t]*>", re.I)
            if not closing.search(line):
                html_end = closing
            continue
        if re.fullmatch(r" {0,3}</?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[^<>]*)?/?>[ \t]*", line):
            html_end = re.compile(r"^[ \t]*$")
            continue
        # Mask code spans before locating comments. Keep original column positions.
        masked = re.sub(
            r"(?<!`)(`+)(?!`)(.*?)(?<!`)\1(?!`)",
            lambda match: " " * len(match[0]), line,
        )
        for comment in re.finditer(r"<!--.*?(?:-->|$)", masked):
            line = line[:comment.start()] + " " * len(comment[0]) + line[comment.end():]
            in_comment = not comment[0].endswith("-->")
        heading = re.fullmatch(r" {0,3}(#{1,6})(?:[ \t]+(.*))?", line)
        if heading:
            title = re.sub(r"(?:^|[ \t]+)#+[ \t]*$", "", heading[2] or "").strip()
            if title:
                yield len(heading[1]), title


def lint_recipe(path: Path, root: Path) -> list[str]:
    name = path.relative_to(root).as_posix()
    if not path.is_file():
        return [f"{name}: required file is missing or is not a file"]
    try:
        source = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        return [f"{name}: cannot read UTF-8 recipe: {error}"]
    headings = list(markdown_headings(source))
    errors = []
    if not any(level == 1 for level, _ in headings):
        errors.append(f"{name}: missing non-empty H1 title (# Name)")
    for section in REQUIRED_SECTIONS:
        if (2, section) not in headings:
            errors.append(f"{name}: missing section: ## {section}")
    return errors


def lint_repository(root: Path) -> list[str]:
    if not root.is_dir():
        return [f"{root}: expected an existing directory"]
    errors = []
    recipes = []
    root_recipe = root / "RECIPE.md"
    if root_recipe.exists() or root_recipe.is_symlink():
        recipes.append(root_recipe)
    mods = root / "mods"
    if mods.is_dir():
        for mod in sorted(mods.iterdir()):
            if not mod.is_dir():
                continue
            recipes.append(mod / "RECIPE.md")
            preview = mod / "preview.png"
            if not preview.is_file():
                name = preview.relative_to(root).as_posix()
                errors.append(f"{name}: required file is missing or is not a file")
    elif mods.exists() or mods.is_symlink():
        errors.append("mods: expected a directory")
    if not recipes and not errors:
        errors.append("no recipe targets found; expected RECIPE.md or mods/*/RECIPE.md")
    for recipe in recipes:
        errors.extend(lint_recipe(recipe, root))
    return errors


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "directory", type=Path, nargs="?", default=Path("."),
        help="repository directory (default: current directory)",
    )
    args = parser.parse_args(argv)
    try:
        errors = lint_repository(args.directory)
    except OSError as error:
        errors = [f"{args.directory}: cannot inspect repository: {error}"]
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        print(f"FAIL: {len(errors)} recipe error(s).", file=sys.stderr)
        return 1
    print("PASS: recipe files, mod previews, and required headings are present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
