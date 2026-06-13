/**
 * Tests for breadcrumb truncation. Importing this module under Node must not
 * touch canvas; tests inject a deterministic text measurer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  truncateBreadcrumbs,
  setTextMeasurer,
  CRUMB_H_PAD,
  SEPARATOR_WIDTH,
  CONTAINER_H_PAD,
  type Breadcrumb,
} from "$lib/domain/breadcrumb-truncation";

// 10px per character — crumb width = name.length * 10 + padding.
const PER_CHAR = 10;
const crumbWidth = (name: string) => name.length * PER_CHAR + CRUMB_H_PAD + SEPARATOR_WIDTH;

const crumbs: Breadcrumb[] = [
  { name: "home", path: "/home" },
  { name: "user", path: "/home/user" },
  { name: "projects", path: "/home/user/projects" },
  { name: "app", path: "/home/user/projects/app" },
];

const totalWidth = crumbs.reduce((sum, c) => sum + crumbWidth(c.name), 0) + CONTAINER_H_PAD;

describe("truncateBreadcrumbs", () => {
  beforeEach(() => {
    setTextMeasurer((text) => text.length * PER_CHAR);
  });

  it("returns all crumbs when they fit", () => {
    expect(truncateBreadcrumbs(crumbs, totalWidth + 1)).toEqual(crumbs);
  });

  it("collapses middle crumbs into an ellipsis when space is tight", () => {
    const result = truncateBreadcrumbs(crumbs, totalWidth - 1);
    // "user" is collapsed into the ellipsis; first and last crumbs survive.
    expect(result).toEqual([crumbs[0], { name: "…", path: null }, crumbs[2], crumbs[3]]);
  });

  it("falls back to first + ellipsis + last when nothing else fits", () => {
    const result = truncateBreadcrumbs(crumbs, 10);
    expect(result).toEqual([crumbs[0], { name: "…", path: null }, crumbs[3]]);
  });

  it("returns short crumb lists unchanged even at zero width", () => {
    const two = crumbs.slice(0, 2);
    expect(truncateBreadcrumbs(two, 0)).toEqual(two);
    expect(truncateBreadcrumbs([], 100)).toEqual([]);
  });
});
