# CSV preview tables

CSV preview data is parsed before applying the preview row limit: splitting on
physical newlines first would corrupt valid fields that contain quoted newlines.
Keep the CSV branch isolated from Markdown and general text rendering, and use
the shared `VirtualList` for its bounded record rows.
