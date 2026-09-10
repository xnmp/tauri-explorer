# Keep unsent report text outside the dialog

The Report Issue dialog stays mounted while it is closed, but its opening effect
reset its component-local fields. Keep the text-only draft in an importable,
debounced persisted state store so closing the dialog or restarting the app
does not discard an unsent report. Attachments deliberately remain in the
existing in-session retry draft because binary data is not suitable for this
small localStorage record.
