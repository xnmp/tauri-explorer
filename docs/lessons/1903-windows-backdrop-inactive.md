# #1903: Windows Acrylic/Mica went solid when the window lost focus

- **DWM ties system backdrops to the frame's active state.** Mica and
  system-backdrop acrylic (`DWMWA_SYSTEMBACKDROP_TYPE`) render only while the
  frame is active, meaning the last `WM_NCACTIVATE` that `DefWindowProc` handled.
  Tauri's `WindowEffectState::Active` applies only on macOS and changes nothing
  on Windows. The fix, `src-tauri/src/translucency/inactive_backdrop.rs`, lets
  tao see the real deactivation, so focus events stay correct. It then calls
  `DefWindowProcW(WM_NCACTIVATE, TRUE)` directly. That call bypasses the
  subclass chain, so tao never hears it.
- **Don't rewrite `wParam` for the whole chain.** tao derives `Focused` events
  from `WM_NCACTIVATE`'s `wParam`. Forcing it to TRUE for every handler would
  stop unfocused windows from reporting blur.
- **tao redraws the frame behind the subclass's back.** `Window::set_theme`
  (our `set_window_theme`, called by every window when the theme changes)
  ends with a direct `DefWindowProcW(WM_NCACTIVATE, FALSE)` on an inactive
  window. That runs inside tao's `Tao::ChangeTheme` registered message, so
  the subclass re-activates the frame after that message as well.
- **`on_webview_ready` is too early to read a webview's URL on Windows.**
  WebView2 still reports `about:blank` at that point (tauri#9027). Read the URL
  from `on_page_load` with `PageLoadEvent::Started` instead. A unit test of the
  URL parser can't catch this mistake, which an independent review found.
