# Preview pixel metadata must describe the source (#1299)

The Preview image surface can show a display rendition of a large image. Its `naturalWidth` and `naturalHeight` describe that rendition (1024 × 577 in the report), not the file. Measuring the displayed element therefore produced plausible but incorrect pixel metadata.

Rendition loads now obtain source dimensions through the existing bounded `get_image_resolution` header reader while decoding the rendition. Source dimensions travel with the versioned image cache/content replacement; originals use their decoded intrinsic dimensions. A held image has no metadata for the new selection, an unavailable source header has no pixel row, and stale request owners cannot publish metadata after selection or file-revision changes.

The regression browser test deliberately decodes 1024 × 577 while reporting a 7680 × 4320 source. Unit contracts cover unavailable headers, malformed dimensions, superseded loads, same-path edits and cached revisits. The existing Rust header-reader tests exercise actual temporary image files independently of the browser mock.
