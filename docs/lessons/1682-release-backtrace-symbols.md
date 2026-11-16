# Release panic backtraces need the symbol table (#1682)

`[profile.release] strip = "symbols"` removed the ELF/Mach-O symbol table, so
the panic hook's `Backtrace::force_capture()` printed every frame as
`<unknown>`. The panic message and `file:line` survived (they are compiled in),
the call path did not.

- `strip = "debuginfo"` drops DWARF but keeps the symbol table: frames name
  their functions (no file/line). Measured on the v1.25.2 Linux release binary:
  51.3 MB → 61.1 MB raw, 23.7 MB → 25.0 MB gzipped (the download cost).
- Cargo is not the only stripper. linuxdeploy strips the AppImage unless
  `NO_STRIP` is set (release.yml), and makepkg strips unless the PKGBUILD has
  `'!strip'` (root and `packaging/aur/`). Any new packaging path needs the same
  check: `nm <installed binary> | head` must not say "no symbols".
- Windows is unchanged: MSVC keeps symbols in a separate `.pdb` that the
  installers do not ship, so Windows backtraces still read `<unknown>`.
  Readable Windows traces need shipped or published PDBs.
