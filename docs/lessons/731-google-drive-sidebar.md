# #731: Google Drive sidebar presentation

The unwanted Google Drive shortcut returned whenever drive discovery refreshed.
Filter the sidebar's cloud projection by the backend's `googledrive` provider;
retain the discovered drive and mounted root so direct navigation and its files
remain available. Do not infer provider identity from a mount name or path.

The existing conditional Cloud & Remote section already hides its heading and
divider when that projection is empty. Store tests cover push rediscovery,
other providers, removable volumes and retention of the Google mount. Browser
tests cover refresh, reload, section reopening, neighboring navigation and
direct navigation into the Google Drive fixture. These captures demonstrate
presentation with controlled discovery fixtures, not a native unmount test.
