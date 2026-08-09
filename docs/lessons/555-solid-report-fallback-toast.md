# #555: Opaque fallback notification surfaces

The report-submission fallback already delegates authentication to GitHub's
prefilled issue form. Its error notification must use `--background-solid`,
not translucent acrylic or alpha-only gradients, so the message remains
readable over every app surface and vibrancy backdrop.
