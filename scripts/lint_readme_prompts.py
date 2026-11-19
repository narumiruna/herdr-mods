#!/usr/bin/env python3
"""Check that each Herdr mod README has a copyable installation prompt."""

import argparse
from pathlib import Path
import re
import sys

PROMPT_TEMPLATE = (
    "Read ~/.config/herdr-app/AGENTS.md, then add this mod: "
    "https://github.com/narumiruna/herdr-mods/tree/main/mods/{name}"
)
FENCE = re.compile(r" {0,3}(`{3,}|~{3,})(.*)")
COMMENT_MARKER = re.compile(r"<!--|-->")


def has_install_prompt(source: str, mod_name: str) -> bool:
    """Return whether a closed plain-text fence contains the mod's prompt."""
    expected = PROMPT_TEMPLATE.format(name=mod_name)
    fence = ""
    plain_text = False
    in_comment = False
    body = []
    for line in source.splitlines():
        match = FENCE.fullmatch(line)
        if fence:
            if (
                match
                and match[1][0] == fence[0]
                and len(match[1]) >= len(fence)
                and not match[2].strip()
            ):
                if plain_text and " ".join(" ".join(body).split()) == expected:
                    return True
                fence = ""
                body.clear()
            elif plain_text:
                body.append(line)
        elif in_comment or "<!--" in line:
            for marker in COMMENT_MARKER.findall(line):
                in_comment = marker == "<!--"
        elif match:
            marker, language = match.groups()
            if marker[0] == "~" or "`" not in language:
                fence = marker
                plain_text = language.strip() in ("", "text", "plaintext")
    return False


def lint_repository(root: Path) -> list[str]:
    """Return file-specific errors for missing or invalid install prompts."""
    mods = root / "mods"
    if not mods.is_dir():
        return [f"{mods}: expected a mods directory"]

    errors = []
    found_mod = False
    for mod in sorted(mods.iterdir()):
        if not mod.is_dir() or not any(
            (mod / name).is_file() for name in ("mod.json", "main.js")
        ):
            continue
        found_mod = True
        readme = mod / "README.md"
        path = readme.relative_to(root).as_posix()
        if not readme.is_file():
            errors.append(f"{path}: missing README.md")
            continue
        try:
            source = readme.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as error:
            errors.append(f"{path}: cannot read UTF-8 README: {error}")
            continue
        if not has_install_prompt(source, mod.name):
            errors.append(
                f"{path}: add this installation prompt in a plain-text fence:\n"
                f"  {PROMPT_TEMPLATE.format(name=mod.name)}"
            )
    if not found_mod:
        errors.append(f"{mods}: no mod directories found")
    return errors


def main() -> int:
    """Print the lint result and return the process exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "directory",
        type=Path,
        nargs="?",
        default=Path("."),
        help="repository directory (default: current directory)",
    )
    args = parser.parse_args()
    try:
        errors = lint_repository(args.directory)
    except OSError as error:
        errors = [f"{args.directory}: cannot inspect repository: {error}"]
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("PASS: every mod README has its copyable installation prompt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
