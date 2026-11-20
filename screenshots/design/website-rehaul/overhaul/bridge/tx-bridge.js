/* TXBridge: embed the real Tauri Explorer frontend (site-demo build, served at /app/) in a page
   and drive it over postMessage. Classic script; defines window.TXBridge. Protocol: README.md here.

   TXBridge.mount(iframeOrContainer, { appUrl, fixture, assetBase, settings, keybindings, user, startPath,
                                       requestTimeoutMs = 15000, mountTimeoutMs = 0 })
     → Promise<stage>, resolved when the app reports `ready` (rejected after mountTimeoutMs when > 0).
   Every request rejects after requestTimeoutMs (stage.call.withTimeout(ms, method, ...params) overrides
   it per call), and pending requests reject when the frame reloads or the stage is destroyed.
*/
(function () {
  "use strict";
  var PROTOCOL = "tauri-explorer";
  var VERSION = 1;

  function plainClone(value) {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch (e) { return JSON.parse(JSON.stringify(value)); }
  }

  function mount(target, opts) {
    opts = opts || {};
    var iframe = target && target.tagName === "IFRAME" ? target : document.createElement("iframe");
    if (iframe !== target) {
      iframe.style.cssText = "border:0;width:100%;height:100%;display:block";
      target.appendChild(iframe);
    }
    iframe.setAttribute("title", iframe.getAttribute("title") || "Tauri Explorer");
    var appUrl = new URL(opts.appUrl || "/app/", location.href);
    if (appUrl.origin !== location.origin) {
      return Promise.reject(new Error("TXBridge: the app must be served from this page's origin"));
    }
    var origin = location.origin;
    var listeners = {};
    var pending = {};
    var nextId = 1;
    var requestTimeoutMs = opts.requestTimeoutMs === undefined ? 15000 : opts.requestTimeoutMs;
    var destroyed = false;
    var init = {
      tx: PROTOCOL, v: VERSION, type: "init",
      fixture: plainClone(opts.fixture),
      assetBase: new URL(opts.assetBase || "./", location.href).href,
    };
    if (opts.user) init.user = opts.user;
    if (opts.settings) init.settings = plainClone(opts.settings);
    if (opts.keybindings) init.keybindings = plainClone(opts.keybindings);
    if (opts.startPath) init.startPath = opts.startPath;
    if (opts.fixture === undefined) delete init.fixture;

    function emit(event, data) {
      (listeners[event] || []).slice().forEach(function (fn) {
        try { fn(data); } catch (e) { console.error("TXBridge listener for " + event + " failed", e); }
      });
      (listeners["*"] || []).slice().forEach(function (fn) {
        try { fn(event, data); } catch (e) { console.error("TXBridge * listener failed", e); }
      });
    }

    function settle(id) {
      var waiter = pending[id];
      if (!waiter) return null;
      delete pending[id];
      clearTimeout(waiter.timer);
      return waiter;
    }

    /** Reject every request still waiting: its answer can no longer arrive. */
    function rejectPending(reason) {
      Object.keys(pending).forEach(function (id) {
        var waiter = settle(id);
        waiter.reject(new Error("TXBridge: " + waiter.method + " " + reason));
      });
    }

    function request(timeoutMs, method, params) {
      return new Promise(function (resolve, reject) {
        if (destroyed) return reject(new Error("TXBridge: " + method + " called after destroy()"));
        if (!iframe.contentWindow) return reject(new Error("TXBridge: the app frame is not attached"));
        var id = nextId++;
        var waiter = { resolve: resolve, reject: reject, method: method, timer: 0 };
        if (timeoutMs > 0) {
          waiter.timer = setTimeout(function () {
            if (settle(id)) reject(new Error("TXBridge: " + method + " timed out after " + timeoutMs + " ms"));
          }, timeoutMs);
        }
        pending[id] = waiter;
        iframe.contentWindow.postMessage({ tx: PROTOCOL, v: VERSION, type: "request", id: id, method: method, params: params }, origin);
      });
    }

    function call(method) {
      return request(requestTimeoutMs, method, Array.prototype.slice.call(arguments, 1));
    }
    call.withTimeout = function (timeoutMs, method) {
      return request(timeoutMs, method, Array.prototype.slice.call(arguments, 2));
    };

    var stage = {
      iframe: iframe,
      catalog: null,
      state: null,
      /** How the app booted: { fixture: "provided" | "builtin", error, warnings }. */
      boot: null,
      call: call,
      getState: function () { return call("getState"); },
      getCatalog: function () { return call("getCatalog"); },
      setSettings: function (partial) { return call("setSettings", partial); },
      setKeybinding: function (commandId, keys) { return call("setKeybinding", commandId, keys === undefined ? null : keys); },
      resetKeybinding: function (commandId) { return call("resetKeybinding", commandId); },
      resetKeybindings: function () { return call("resetKeybindings"); },
      run: function (commandId) { return call("run", commandId); },
      navigate: function (path, pane) { return call("navigate", path, pane); },
      setPanel: function (panelId, visible) { return call("setPanel", panelId, visible); },
      /** options.path opens the second pane there; options.focus (default true) makes it active. */
      setSplit: function (on, options) { return options ? call("setSplit", !!on, options) : call("setSplit", !!on); },
      setViewMode: function (mode, pane) { return call("setViewMode", mode, pane); },
      setTerminalOpen: function (on) { return call("setTerminalOpen", !!on); },
      playVideo: function (path) { return call("playVideo", path); },
      readFile: function (path) { return call("readFile", path); },
      setCustomTheme: function (theme) { return call("setCustomTheme", theme); },
      /** Give the app keyboard focus again (e.g. after re-showing a closed or minimized window). */
      focusApp: function () { return call("focusApp"); },
      setTouchLayout: function (on) { return call("setTouchLayout", on); },
      closeOverlays: function () { return call("closeOverlays"); },
      on: function (event, fn) {
        (listeners[event] = listeners[event] || []).push(fn);
        return function () { listeners[event] = (listeners[event] || []).filter(function (f) { return f !== fn; }); };
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        window.removeEventListener("message", onMessage);
        clearTimeout(mountTimer);
        rejectPending("was cancelled: the stage was destroyed");
        rejectReady(new Error("TXBridge: the stage was destroyed before the app was ready"));
        if (iframe !== target) iframe.remove();
      },
    };

    var resolveReady, rejectReady;
    var ready = new Promise(function (resolve, reject) { resolveReady = resolve; rejectReady = reject; });
    var mountTimer = 0;

    function onMessage(event) {
      if (event.source !== iframe.contentWindow || event.origin !== origin) return;
      var data = event.data;
      if (!data || data.tx !== PROTOCOL || data.v !== VERSION) return;
      if (data.type === "hello") {
        // Also answers a reload of the frame: every boot asks for its world again,
        // and nothing the previous document was asked can be answered any more.
        rejectPending("was cancelled: the app frame reloaded");
        iframe.contentWindow.postMessage(init, origin);
      } else if (data.type === "response") {
        var waiter = settle(data.id);
        if (!waiter) return;
        if (data.ok) waiter.resolve(data.result); else waiter.reject(new Error(data.error));
      } else if (data.type === "event") {
        if (data.event === "appearance" && data.data) {
          // A browser paints an opaque backdrop behind a frame whose color scheme differs from
          // its element's; keep them equal so a translucent app shows the page behind it.
          iframe.style.colorScheme = data.data.colorScheme || "";
        }
        if (data.event === "ready") {
          stage.catalog = data.data.catalog;
          stage.state = data.data.state;
          stage.boot = data.data.boot || null;
          clearTimeout(mountTimer);
          resolveReady(stage);
        }
        emit(data.event, data.data);
      }
    }

    window.addEventListener("message", onMessage);
    if (opts.mountTimeoutMs > 0) {
      mountTimer = setTimeout(function () {
        rejectReady(new Error("TXBridge: the app was not ready after " + opts.mountTimeoutMs + " ms"));
      }, opts.mountTimeoutMs);
    }
    iframe.src = appUrl.href;
    return ready;
  }

  window.TXBridge = { mount: mount, PROTOCOL: PROTOCOL, VERSION: VERSION };
})();
