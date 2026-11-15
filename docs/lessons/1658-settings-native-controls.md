# #1658 — Language models settings rendered native widgets

The Settings → AI section was written with its own component-scoped
`input, select, button` rules and never applied the dialog's shared
`.settings-select` / `.settings-button` chrome. With native `appearance`, the
Linux WebKitGTK build painted its GTK dropdowns (glossy gradient, oversized
arrow), a plain checkbox and unevenly sized buttons, so the section looked
foreign next to every other Settings row.

Multi-field Settings editors now use `components/settings/settings-form.css`
(`.settings-field`, `.settings-input`, `.settings-group`, a visible-checkbox
`.settings-switch`, `.settings-button.primary`). The switch styles the real
checkbox with `appearance: none` instead of hiding it like `SettingToggle`, so
Playwright `check()`/`toBeVisible()` and keyboard focus keep working.

`e2e/language-models-settings.spec.ts` asserts the computed chrome (no native
appearance, one shared control height, shared button classes) so a new field
added with bare markup fails the suite.
