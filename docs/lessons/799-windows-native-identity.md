# 799 — Directory spellings converge before listing and watch ownership

Windows paths can spell one directory with different separators, component
case, or a trailing separator. Keying the native watch registry before resolving
those spellings creates independent leases over one OS directory; retiring one
key can then remove observation still owned through another spelling.

Resolve the directory once at each native listing/watch admission boundary and
return that resolved spelling in both the listing and watch lease. The frontend
must publish readiness from the returned lease path rather than the requested
path. This keeps the listing cache, pane state, watch registry and event path on
one identity without introducing a second lifecycle owner.

Unix resolution is lexical and case-sensitive. Windows local drive paths resolve
each existing component to its stored long-name case, but only after the
requested spelling itself resolves: an insensitive `FindFirstFileExW` match can
otherwise turn a nonexistent name into an existing entry inside a per-directory
case-sensitive NTFS directory. UNC server/share spelling stays as requested and
its case variants can therefore retain separate registry keys; this is an
explicit limitation because those root components cannot be enumerated through
the same lookup. WSL
shares also retain component case because their backing filesystem may be
case-sensitive. Device and verbatim namespaces remain literal.

Physical file identity is separate from path spelling. Windows recovery queries
`FileIdInfo` from an already-open handle, so case variants, hardlinks and an 8.3
alias (when short-name creation is enabled on the runner volume) must return the
same volume serial and complete 128-bit file identifier. A missing distinct 8.3
alias is recorded as an unsupported volume configuration rather than evidence
that the identity comparison passed.
