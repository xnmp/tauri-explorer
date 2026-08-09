# #554: Keep report dialog actions in the shared control language

The report dialog originally added only footer-button padding, leaving the
browser's default border and transparent-background treatment visible. Dialog
actions should opt into the shared `.modal-card .btn` contract with its
`secondary` or `primary` variant instead of duplicating that contract locally.
This keeps themed fill, stroke, radius, active, disabled, hover, and focus
states aligned with every other modal.
