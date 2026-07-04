/**
 * Lane assignment for the commit graph (#58).
 */

import { describe, it, expect } from "vitest";
import { assignLanes } from "$lib/domain/git-graph";

const c = (oid: string, ...parents: string[]) => ({ oid, parents });

describe("assignLanes", () => {
  it("keeps a linear history in one lane", () => {
    const { rows, laneCount } = assignLanes([c("c3", "c2"), c("c2", "c1"), c("c1")]);
    expect(laneCount).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    // Middle row continues straight down; root has no outgoing edge.
    expect(rows[0].edges).toEqual([{ from: 0, to: 0 }]);
    expect(rows[2].edges).toEqual([]);
  });

  it("routes a merge across two lanes and joins at the fork point", () => {
    // main: m3(merge of m2,f2) → m2 → base; feature: f2 → base
    const commits = [
      c("m3", "m2", "f2"),
      c("f2", "base"),
      c("m2", "base"),
      c("base"),
    ];
    const { rows, laneCount } = assignLanes(commits);
    expect(laneCount).toBe(2);

    const [merge, feature, main, base] = rows;
    expect(merge.lane).toBe(0);
    // Merge row: first parent continues in lane 0, second forks to lane 1.
    expect(merge.edges).toContainEqual({ from: 0, to: 0 });
    expect(merge.edges).toContainEqual({ from: 0, to: 1 });
    // Feature commit sits in its forked lane and passes main's lane through.
    expect(feature.lane).toBe(1);
    expect(feature.edges).toContainEqual({ from: 0, to: 0 });
    // Both lines converge on base: one of the rows above it merges lanes.
    expect(base.lane).toBe(0);
    const joinEdges = [...feature.edges, ...main.edges].filter((e) => e.from !== e.to);
    expect(joinEdges.length).toBeGreaterThan(0);
  });

  it("handles multiple roots (orphan histories) without lane collisions", () => {
    const { rows } = assignLanes([c("a2", "a1"), c("b1"), c("a1")]);
    expect(rows[0].lane).not.toBe(rows[1].lane);
    // a1 lands back in a2's lane.
    expect(rows[2].lane).toBe(rows[0].lane);
  });

  it("handles empty input", () => {
    expect(assignLanes([])).toEqual({ rows: [], laneCount: 0 });
  });

  it("octopus merges fork one edge per extra parent", () => {
    const { rows } = assignLanes([c("m", "p1", "p2", "p3"), c("p1"), c("p2"), c("p3")]);
    const out = rows[0].edges.filter((e) => e.from === rows[0].lane);
    expect(out).toHaveLength(3);
  });
});
