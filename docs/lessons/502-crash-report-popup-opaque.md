# Issue 502: Keep crash notices readable

The crash notice is displayed over the app's animated and translucent surfaces,
so it must use the opaque `--background-solid` theme token rather than the
translucent `--background-card` token. The browser regression test checks the
computed background color at the rendered notice, where the user-visible
contrast is produced.
