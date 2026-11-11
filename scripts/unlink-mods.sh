#!/bin/sh
set -eu

repo_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
. "$repo_root/scripts/mod-link-path.sh"
mods_dir="${HOME:?HOME must be set}/.config/herdr-app/mods"

for target in "$mods_dir"/*; do
    [ -L "$target" ] || continue
    source="$repo_root/mods/${target##*/}"

    if link_points_to_mod "$target" "$source"; then
        rm "$target"
        printf 'Unlinked: %s\n' "$target"
    fi
done
