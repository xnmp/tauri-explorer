import { describe, expect, it } from "vitest";
import {
  dropGraphFileHistory,
  queueGraphFileHistory,
  registerGraphFileHistoryHandler,
  showFileHistoryInPane,
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

  it("delivers a second file immediately when the graph already shows its repository", () => {
    const pane = "open-graph-pane";
    const received: string[] = [];
    const remove = registerGraphFileHistoryHandler(pane, (path) => received.push(path));
    const opened: string[] = [];

    showFileHistoryInPane(pane, "/repo", "src/next.ts", {
      currentRepoPath: "/repo",
      showGraph: (repo) => opened.push(repo),
    });

    expect(received).toEqual(["src/next.ts"]);
    expect(opened).toEqual([]);
    remove();
  });

  it("drops a pending request when its pane closes", () => {
    const pane = "closed-graph-pane";
    queueGraphFileHistory(pane, "src/abandoned.ts");
    dropGraphFileHistory(pane);
    const received: string[] = [];
    const remove = registerGraphFileHistoryHandler(pane, (path) => received.push(path));

    expect(received).toEqual([]);
    remove();
  });
});
