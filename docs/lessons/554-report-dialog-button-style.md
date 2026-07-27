# #554: Keep report dialog actions in the shared control language

The report dialog owns its footer button styles, so adding only padding leaves
the browser's default border and transparent-background treatment visible.
Action buttons in this dialog should define the same control contract as the
rest of the app: themed fill and stroke, the shared radius, a primary accent
variant, and keyboard-visible focus/hover states.
