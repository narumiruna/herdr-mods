#!/bin/sh
set -eu

repo_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
. "$repo_root/scripts/link-path.sh"
app_home="${HOME:?HOME must be set}/.config/herdr-app"
status=0

for kind in mods layouts; do
    target_dir="$app_home/$kind"
    mkdir -p "$target_dir"

    for source in "$repo_root/$kind"/*; do
        case "$kind" in
            mods) [ -d "$source" ] || continue ;;
            layouts)
                [ -f "$source" ] || continue
                case "$source" in
                    *.json|*.svg) ;;
                    *) continue ;;
                esac
                ;;
        esac
        target="$target_dir/${source##*/}"

        if link_points_to_source "$target" "$source"; then
            printf 'Already linked: %s\n' "$target"
        elif [ -e "$target" ] || [ -L "$target" ]; then
            printf 'Conflict, not changed: %s\n' "$target" >&2
            status=1
        else
            ln -s "$source" "$target"
            printf 'Linked: %s -> %s\n' "$target" "$source"
        fi
    done
done

exit "$status"
