#!/bin/sh
set -eu

repo_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
. "$repo_root/scripts/link-path.sh"
app_home="${HOME:?HOME must be set}/.config/herdr-app"

for kind in mods layouts; do
    for target in "$app_home/$kind"/*; do
        [ -L "$target" ] || continue
        if [ "$kind" = layouts ]; then
            case "$target" in
                *.json|*.svg) ;;
                *) continue ;;
            esac
        fi
        source="$repo_root/$kind/${target##*/}"

        if link_points_to_source "$target" "$source"; then
            rm "$target"
            printf 'Unlinked: %s\n' "$target"
        fi
    done
done
