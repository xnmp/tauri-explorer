# User themes keep light-dark() in release builds (#1728)

Vite 8 minifies CSS with Lightning CSS, which by default compiles `light-dark()`
into `var(--lightningcss-light, ...) var(--lightningcss-dark, ...)`. Those
variables are toggled only beside the `color-scheme` rules of the stylesheet that
contained the function, i.e. the bundled themes. Runtime-loaded user themes set
their own `color-scheme` but never define the variables, so the tint and island
surfaces painted nothing in the installed app while `bun run dev` (no minifier)
looked fine.

Fix: `css.lightningcss.exclude: Features.LightDark` in `vite.config.ts`
(`lightningcss` is a direct devDependency, pinned to the version Vite resolves).
Guard: `scripts/check-bundle-size.mjs` fails when any built CSS contains
`--lightningcss-light/dark` (`scripts/css-polyfill-leaks.mjs`, unit-tested in
`tests/css-polyfill-leaks.test.ts`).

Always check production output for CSS features, not only the dev server.
