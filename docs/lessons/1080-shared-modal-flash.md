# 1080 — shared modal entrances flashed through to the file listing

The report first identified Ctrl+E, then Configure connections. Both use the
host's `Modal`, so an AI-dialog-only override cannot fix the shared cause.

`Modal.svelte` faded the full blurred overlay. Standard cards and several
custom cards also animated opacity and transform. This repeated the WebKitGTK
surface-teardown pattern established by #1062: a composited animation ending
on a backdrop-filter element or its contents can drop a painted frame.

The backdrop now appears immediately. Standard cards use the already proven
clip-path/margin reveal; Settings, Jobs and AI Organize reuse those keyframes.
The delete dialog's finite icon opacity/scale entrance was removed too.
Palette dialogs retain their immediate appearance, and reduced-motion users
receive no card entrance animation.

Installed plugins can carry independent copies of the old `.plugin-dialog`
CSS. The shared modal therefore supplies the safe entrance to its direct
plugin cards with sufficient specificity to beat those styles. The rule does
not target nested editor tool panels. No wrapper, focus, dismissal or SDK
contract changes are necessary.

The browser regression samples opacity and finite entrance keyframes at
insertion and on frames, then verifies dismissal preserves files/focus and
Settings remains usable. The pre-fix modal fails all three new cases.
Chromium cannot reproduce the compositor dropout itself; native verification
must record the actual modal, including nested settings and restored parent
drafts, through entrance completion on an isolated display.

Independent WebKitGTK 2.54.1 verification used the real host modal and image
forms, with the plugin's earlier modal override removed. Four AI openings and
four nested Configure connections openings produced 1,777 recorded frames
without an unexpected underlying-listing frame. Closing connections preserved
the prompt draft and restored the parent dialog. All 1,189 sampled animation
frames retained opaque roots and the blurred backdrop. This ran on private
Xvfb; it does not establish behavior on every Wayland/Tauri renderer stack.

Loading spinners and validation-error feedback are separate from entrance
effects; do not blanket-disable descendant animation to fix modal openings.
