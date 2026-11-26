# Plugin start failures outlive the install they describe (#1597)

`src/lib/plugins/installed.ts` records why an enabled package could not start
in a module-level `failures` map, and Settings → Plugins renders it as an alert
on that package's row. Only a later successful load removed the entry, so
disabling or uninstalling the broken package left the "could not start" alert
showing on a package that was no longer being started (and on a reinstall
that stayed disabled).

A failure is a fact about one enabled install. `refreshInstalledPackages` now
prunes every failure whose id is not enabled in the freshly listed packages
before it loads anything. Regression test:
`tests/plugins/installed.test.ts` ("clears a start failure once the package is
disabled or uninstalled").

Module-level caches keyed by id need an eviction rule tied to the listing that
defines the ids, not only to the success path.
