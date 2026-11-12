# Match the checkout path without following the final source entry.
link_points_to_source() (
    [ -L "$1" ] || exit 1
    candidate=$(readlink "$1") || exit 1
    expected=$2

    case "$candidate" in
        /*) ;;
        *)
            link_dir=$(CDPATH= cd -P "${1%/*}" && pwd -P) || exit 1
            candidate="$link_dir/$candidate"
            ;;
    esac
    while [ "${candidate%/}" != "$candidate" ]; do
        candidate=${candidate%/}
    done

    [ "$candidate" = "$expected" ] && exit 0

    # Remove matching missing entries until both parent directories exist.
    # This also handles removed source directories without following source links.
    while [ "${candidate##*/}" = "${expected##*/}" ]; do
        candidate=${candidate%/*}
        expected=${expected%/*}
        [ -n "$candidate" ] && [ -n "$expected" ] || exit 1

        if [ -d "$candidate" ] && [ -d "$expected" ]; then
            candidate=$(CDPATH= cd -P "$candidate" && pwd -P) || exit 1
            expected=$(CDPATH= cd -P "$expected" && pwd -P) || exit 1
            [ "$candidate" = "$expected" ]
            exit
        fi

        # For dangling parent links, compare their names and physical parents.
        if [ -L "$candidate" ] && [ -L "$expected" ]; then
            continue
        fi

        # Do not strip an existing foreign parent.
        if [ -e "$candidate" ] || [ -L "$candidate" ] ||
           [ -e "$expected" ] || [ -L "$expected" ]; then
            exit 1
        fi
    done
    exit 1
)
