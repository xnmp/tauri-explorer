import { describe, expect, it } from "vitest";
import {
  queueGraphFileHistory,
  registerGraphFileHistoryHandler,
} from "$lib/state/git-graph-file-history";

describe("per-pane Git Graph file-history handoff", () => {
  it("delivers a queued path to the replacement graph instead of the outgoing one", () => {
    const pane = "replacement-graph-pane";
    const outgoing: string[] = [];
    const removeOutgoing = registerGraphFileHistoryHandler(pane, (path) => outgoing.push(path));

    queueGraphFileHistory(pane, "src/index.css");
    removeOutgoing();

    const incoming: string[] = [];
    const removeIncoming = registerGraphFileHistoryHandler(pane, (path) => incoming.push(path));
    expect(outgoing).toEqual([]);
    expect(incoming).toEqual(["src/index.css"]);
    removeIncoming();
  });
});
