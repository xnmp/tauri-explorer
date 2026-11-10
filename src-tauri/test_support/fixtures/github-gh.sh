#!/bin/sh
# Execute a stable inode; the per-repository response is input, not an exec target.
# This avoids ETXTBSY if a concurrent fork inherits a writable response descriptor.
exec /bin/sh ./fake-gh "$@"
