#!/bin/sh
set -eu

repo_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
mods_dir="${HOME:?HOME must be set}/.config/herdr-app/mods"

for target in "$mods_dir"/*; do
    [ -L "$target" ] || continue
    source="$repo_root/mods/${target##*/}"

    # Compare the stored path so links with missing sources can also be removed.
    if [ "$(readlink "$target")" = "$source" ]; then
        rm "$target"
        printf 'Unlinked: %s\n' "$target"
    fi
done
