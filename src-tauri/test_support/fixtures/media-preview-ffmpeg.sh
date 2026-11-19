#!/bin/sh
# $0 is the per-test symlink; its generated sibling is shell input, never exec'd.
# Retained writable descriptors on that input therefore cannot cause ETXTBSY.
exec /bin/sh "$0.sh" "$@"
