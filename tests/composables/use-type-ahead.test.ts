/**
 * Type-ahead Space handling: Space must only be consumed while a match is in
 * progress (non-empty buffer). With an empty buffer it must fall through to
 * the default behavior (button activation / scroll); mid-match it must
 * preventDefault so typing a name with spaces doesn't activate the focused row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("$lib/state/keybindings.svelte", () => ({
  keybindingsStore: { isChordActive: false },
}));

import { useTypeAhead } from "$lib/composables/use-type-ahead.svelte";
import type { FileEntry } from "$lib/domain/file";

function makeEntry(name: string): FileEntry {
  return { name, path: `/home/user/${name}`, kind: "file" } as FileEntry;
}

function makeKeyEvent(key: string, overrides: Partial<KeyboardEvent> = {}) {
  const preventDefault = vi.fn();
  const event = {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { tagName: "DIV" },
    preventDefault,
    ...overrides,
  } as unknown as KeyboardEvent;
  return { event, preventDefault };
}

describe("useTypeAhead Space handling", () => {
  const entries = [makeEntry("my file.txt"), makeEntry("other.txt")];
  let matches: string[];
  let typeAhead: ReturnType<typeof useTypeAhead>;

  beforeEach(() => {
    vi.useFakeTimers();
    matches = [];
    typeAhead = useTypeAhead(
      () => entries,
      (entry) => matches.push(entry.name),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves Space to its default behavior when the buffer is empty", () => {
    const { event, preventDefault } = makeKeyEvent(" ");
    expect(typeAhead.handleKeydown(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(matches).toEqual([]);
  });

  it("consumes Space and prevents default mid-match", () => {
    typeAhead.handleKeydown(makeKeyEvent("m").event);
    typeAhead.handleKeydown(makeKeyEvent("y").event);

    const { event, preventDefault } = makeKeyEvent(" ");
    expect(typeAhead.handleKeydown(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalled();

    // The space participated in the match: "my f" still matches "my file.txt"
    typeAhead.handleKeydown(makeKeyEvent("f").event);
    expect(matches.at(-1)).toBe("my file.txt");
  });

  it("falls back to default Space behavior after the buffer times out", () => {
    typeAhead.handleKeydown(makeKeyEvent("m").event);
    vi.advanceTimersByTime(900); // buffer cleared (timeout is 800ms)

    const { event, preventDefault } = makeKeyEvent(" ");
    expect(typeAhead.handleKeydown(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("ignores keys when focus is in an input field", () => {
    const { event } = makeKeyEvent("m", {
      target: { tagName: "INPUT" },
    } as unknown as Partial<KeyboardEvent>);
    expect(typeAhead.handleKeydown(event)).toBe(false);
  });
});
