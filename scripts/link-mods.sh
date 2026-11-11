#!/bin/sh
set -eu

repo_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
. "$repo_root/scripts/mod-link-path.sh"
mods_dir="${HOME:?HOME must be set}/.config/herdr-app/mods"
status=0

mkdir -p "$mods_dir"

for source in "$repo_root"/mods/*; do
    [ -d "$source" ] || continue
    target="$mods_dir/${source##*/}"

    if link_points_to_mod "$target" "$source"; then
        printf 'Already linked: %s\n' "$target"
    elif [ -e "$target" ] || [ -L "$target" ]; then
        printf 'Conflict, not changed: %s\n' "$target" >&2
        status=1
    else
        ln -s "$source" "$target"
        printf 'Linked: %s -> %s\n' "$target" "$source"
    fi
done

exit "$status"
