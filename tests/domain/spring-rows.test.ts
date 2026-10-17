import { describe, expect, it } from "vitest";
import { springRowOf } from "$lib/domain/spring-rows";
import { dropElement } from "../helpers/drop-element";

// One row resolver for the spring hover and the spring drop (#1242): the two
// drifted once (a Details row wrapper kept a peek open but dropped elsewhere).
describe("springRowOf", () => {
  const content = () => dropElement("content", {});

  it("reads a row element as a directory or a file by its class", () => {
    const parent = content();
    const folder = dropElement("entry-item directory", { "data-path": "/r/Inbox" }, parent);
    const file = dropElement("entry-item", { "data-path": "/r/a.txt" }, parent);
    expect(springRowOf(dropElement("icon", {}, folder))).toEqual({ path: "/r/Inbox", kind: "directory" });
    expect(springRowOf(file)).toEqual({ path: "/r/a.txt", kind: "file" });
  });

  it("reads a Details row wrapper like the row it wraps", () => {
    const parent = content();
    expect(springRowOf(dropElement("", { "data-row-path": "/r/Inbox", "data-row-kind": "directory" }, parent))).toEqual({ path: "/r/Inbox", kind: "directory" });
    expect(springRowOf(dropElement("", { "data-row-path": "/r/a.txt", "data-row-kind": "file" }, parent))).toEqual({ path: "/r/a.txt", kind: "file" });
    expect(springRowOf(dropElement("", { "data-row-path": "/r/Empty", "data-row-kind": "state" }, parent))).toEqual({ path: "/r/Empty", kind: "state" });
  });

  it("names peek-state rows and bridges by their folder; the nearest identity wins", () => {
    const parent = content();
    const wrapper = dropElement("", { "data-row-path": "/r/Empty", "data-row-kind": "state" }, parent);
    const state = dropElement("peek-state", { "data-peek-state": "/r/Empty" }, wrapper);
    expect(springRowOf(dropElement("", {}, state))).toEqual({ path: "/r/Empty", kind: "state" });
    expect(springRowOf(dropElement("outline-bridge-hit", { "data-spring-bridge": "/r/Inbox" }, parent))).toEqual({ path: "/r/Inbox", kind: "bridge" });
  });

  it("is null off every row, and for malformed identities", () => {
    expect(springRowOf(null)).toBeNull();
    expect(springRowOf(content())).toBeNull();
    expect(springRowOf(dropElement("", { "data-row-path": "", "data-row-kind": "file" }, content()))).toBeNull();
    expect(springRowOf(dropElement("", { "data-row-path": "/r/x", "data-row-kind": "bogus" }, content()))).toBeNull();
    expect(springRowOf(dropElement("", { "data-row-path": "/r/x" }, content()))).toBeNull();
    expect(springRowOf(dropElement("entry-item", { "data-path": "" }, content()))).toBeNull();
    expect(springRowOf(dropElement("", { "data-spring-bridge": "" }, content()))).toBeNull();
  });
});
