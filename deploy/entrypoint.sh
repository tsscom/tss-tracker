#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
    storage_directory="${DATA_DIR:-/var/data}"
    attachments_directory="${ATTACHMENTS_DIR:-$storage_directory/attachments}"
    for directory in "$storage_directory" "$attachments_directory"; do
        if [ -L "$directory" ]; then
            echo "Storage directories must not be symbolic links." >&2
            exit 1
        fi
        mkdir -p "$directory"
        chown --no-dereference node:node "$directory"
    done
    exec gosu node "$@"
fi

exec "$@"
