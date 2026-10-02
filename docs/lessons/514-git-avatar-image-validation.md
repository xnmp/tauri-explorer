# #514: Avatar cache validation must decode pixel data

An independent review of PR #725 found that `ImageReader::into_dimensions`
accepts a PNG with complete headers and truncated pixel data. Accepting those
bytes published a positive avatar cache entry that persisted across restarts.
The browser displayed the local fallback, but later lookups kept returning the
same broken image instead of replacing it.

Validate encoded size and dimensions first, then fully decode before returning
a MIME type or admitting downloaded or cached bytes. Apply strict dimension
limits and decoder allocation limits to header inspection and full decoding.
Failed cached validation must remove the derived entry so the normal downloader
can repair it; invalid downloads enter the existing expiring negative cache.

Two regressions call production `load_or_fetch`: a header-valid truncated PNG
download must create no positive entry, and the same persisted bytes must be
replaced by a valid download that subsequent lookups reuse. Both failed on the
pre-fix branch and passed with complete decoding.
