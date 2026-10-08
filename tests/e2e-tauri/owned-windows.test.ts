import { describe, expect, it } from "vitest";
import { isWarmWindowUrl, mayScriptPage, selectWindowByLabel } from "../../e2e-tauri/owned-windows";

describe("native window-label scan", () => {
  it("accepts a ready target reached after a slow complete handle scan", async () => {
    let elapsed = 0;
    let selected = "";
    const visited: string[] = [];
    await selectWindowByLabel({
      listHandles: async () => ["main", "parked-warm", "target"],
      switchTo: async (handle) => { selected = handle; visited.push(handle); },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => {
        elapsed += 11_000;
        return selected === "target" ? "requested-child" : undefined;
      },
      pause: async () => { throw new Error("a complete scan already found the target"); },
      now: () => elapsed,
    }, "requested-child", 20_000);

    expect(visited).toEqual(["main", "parked-warm", "target"]);
    expect(elapsed).toBe(33_000);
  });

  it("reports a missing target only after checking every current handle", async () => {
    let elapsed = 0;
    const visited: string[] = [];
    await expect(selectWindowByLabel({
      listHandles: async () => ["main", "parked-warm"],
      switchTo: async (handle) => { visited.push(handle); },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => { elapsed += 11_000; return undefined; },
      pause: async () => { throw new Error("expired scan must not repeat"); },
      now: () => elapsed,
    }, "requested-child", 20_000)).rejects.toThrow(
      "window requested-child did not become ready",
    );
    expect(visited).toEqual(["main", "parked-warm"]);
  });

  it("rescans when the child handle appears after the first pass", async () => {
    let elapsed = 0;
    let selected = "";
    let scans = 0;
    await selectWindowByLabel({
      listHandles: async () => (++scans === 1 ? ["main"] : ["main", "child"]),
      switchTo: async (handle) => { selected = handle; },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => selected === "child" ? "requested-child" : undefined,
      pause: async (ms) => { elapsed += ms; },
      now: () => elapsed,
    }, "requested-child", 20_000);
    expect(scans).toBe(2);
    expect(selected).toBe("child");
  });

  it("skips a handle that closed during the scan and selects the remaining child", async () => {
    let selected = "";
    let handles = ["closing", "child"];
    await selectWindowByLabel({
      listHandles: async () => handles,
      switchTo: async (handle) => {
        if (handle === "closing") {
          handles = ["child"];
          throw new Error("no such window");
        }
        selected = handle;
      },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => selected === "child" ? "requested-child" : undefined,
      pause: async () => { throw new Error("child was in the first scan"); },
      now: () => 0,
    }, "requested-child", 20_000);
    expect(selected).toBe("child");
  });

  it("keeps driver errors visible when the failing handle still exists", async () => {
    const driverError = new Error("driver session lost");
    await expect(selectWindowByLabel({
      listHandles: async () => ["main", "child"],
      switchTo: async () => { throw driverError; },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => undefined,
      pause: async () => {},
      now: () => 0,
    }, "requested-child", 20_000)).rejects.toBe(driverError);
  });
});

describe("owned-page scan (#885, #931)", () => {
  const urls: Record<string, string> = {
    main: "tauri://localhost/",
    warm: "tauri://localhost/?warm=1&path=%2Fhome%2Frunner&home=%2Fhome%2Frunner",
    child: "tauri://localhost/?path=%2Fhome%2Frunner%2Fsource",
  };

  it("never scripts a warm page, even when looking for a warm label", async () => {
    let selected = "";
    const scripted: string[] = [];
    await expect(selectWindowByLabel({
      listHandles: async () => ["main", "warm", "child"],
      switchTo: async (handle) => { selected = handle; },
      currentUrl: async () => urls[selected],
      currentLabel: async () => {
        scripted.push(selected);
        if (selected === "warm") throw new Error("session deleted because of page crash or hang");
        return selected === "child" ? "explorer-child" : "main";
      },
      pause: async () => {},
      now: () => scripted.length * 10_000,
    }, "explorer-warm-1", 20_000)).rejects.toThrow("window explorer-warm-1 did not become ready");
    expect(scripted).not.toContain("warm");
  });

  it("skips a page whose URL is not committed yet and scripts it once it is", async () => {
    let selected = "";
    let pass = 0;
    const scripted: string[] = [];
    const handle = await selectWindowByLabel({
      listHandles: async () => { pass += 1; return ["main", "child"]; },
      switchTo: async (next) => { selected = next; },
      currentUrl: async () => selected === "child" && pass === 1 ? "" : urls[selected],
      currentLabel: async () => {
        scripted.push(`${selected}@${pass}`);
        return selected === "child" ? "explorer-child" : "main";
      },
      pause: async () => {},
      now: () => 0,
    }, "explorer-child", 20_000);
    expect(handle).toBe("child");
    expect(scripted).toEqual(["main@1", "main@2", "child@2"]);
  });

  it("fails closed: scripts only pages with a known, non-warm URL", () => {
    expect(mayScriptPage(urls.main)).toBe(true);
    expect(mayScriptPage(urls.child)).toBe(true);
    expect(mayScriptPage("tauri://localhost/?path=%2Fwarm%3D1")).toBe(true);
    expect(mayScriptPage(urls.warm)).toBe(false);
    expect(mayScriptPage("")).toBe(false);
    expect(mayScriptPage("not a url")).toBe(false);
    expect(isWarmWindowUrl(urls.warm)).toBe(true);
    expect(isWarmWindowUrl(urls.child)).toBe(false);
    expect(isWarmWindowUrl("")).toBe(false);
  });
});
