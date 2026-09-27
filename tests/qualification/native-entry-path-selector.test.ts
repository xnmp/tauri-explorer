import { describe, expect, it, vi } from "vitest";
import { load } from "cheerio";

vi.mock("@wdio/globals", () => ({ browser: {}, $: vi.fn(), $$: vi.fn() }));

import { entryPathSelector } from "../../e2e-tauri/specs/helpers";

describe("native entry path selector", () => {
  it("matches a Windows path containing backslashes and a quote exactly", () => {
    const targetPath = 'C:\\Users\\runner\\quoted" folder\\proof.txt';
    const otherPath = 'C:\\Users\\runner\\quoted" folder\\other.txt';
    const $ = load("<main></main>");
    for (const [id, entryPath] of [["target", targetPath], ["other", otherPath]]) {
      $("main").append($("<div>").attr({ id, class: "entry-item", "data-path": entryPath }));
    }

    expect($(entryPathSelector(targetPath)).map((_, element) => $(element).attr("id")).get())
      .toEqual(["target"]);
  });
});
