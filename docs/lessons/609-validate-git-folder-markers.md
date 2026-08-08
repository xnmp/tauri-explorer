# Validate Git folder markers

Explorer folder decoration must validate a `.git` marker with libgit2. A
regular directory can contain a stale or malformed `.git` file, and treating
the marker's existence as sufficient incorrectly presents that folder as a
Git repository.
