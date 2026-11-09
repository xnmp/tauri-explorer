# #1529 — Plugins menu controls looked like browser defaults

**Symptom.** In the Plugins menu, installed packages showed a bare checkbox
labelled "Enabled", a plain "Remove" text button and an unframed
"Install plugin…" button, unlike every other Settings row.

**Root cause.** `InstalledPluginSettings.svelte` styled its controls with
`--text-color`, `--bg-secondary`, `--border-color` and `--error-color`, none of
which any theme defines. The declarations were invalid at computed-value time,
so the buttons fell back to transparent/unbordered browser chrome; the enable
control was a raw `<input type="checkbox">` rather than the Settings switch.

**Fix.** Package rows render through `settings/SettingRow.svelte` and
`settings/SettingToggle.svelte`, and buttons use the shared
`settings/settings-button.css` (`.settings-button`, `.danger` for Remove).
`PluginSettings.svelte` uses the same switch and button instead of its private
copies. Behaviour (busy gating, errors, refresh) is unchanged.

**Guard.** `tests/ui/plugin-settings-style.test.ts` fails if these components
read a CSS variable the base themes and page tokens do not define, regress to
a bare checkbox, or add transition settling to the button hover.
`e2e/plugins-installed-packages.spec.ts` drives enable/disable/remove against
the mock's `installedPlugins` fixture and compares computed colours with the
theme tokens.

**Gotcha.** An undefined `var(--x)` with no fallback fails silently; grep the
themes before borrowing a variable name from another project.
