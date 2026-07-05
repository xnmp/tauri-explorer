import { describe, expect, it, beforeEach } from "vitest";
import { renameSuggestionStore } from "../../src/lib/state/rename-suggestion.svelte";
import type { FileEntry } from "../../src/lib/domain/file";

function entry(name: string, path = `/home/user/${name}`): FileEntry {
  return { name, path, kind: "file" } as FileEntry;
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("renameSuggestionStore", () => {
  beforeEach(() => {
    renameSuggestionStore.clear();
  });

  it("is inert without a provider", async () => {
    const e = entry("a.txt");
    renameSuggestionStore.fetch(e);
    await flush();
    expect(renameSuggestionStore.suggestionFor(e.path)).toBe(null);
    expect(renameSuggestionStore.pending).toBe(false);
  });

  it("surfaces the provider's suggestion keyed to the entry path", async () => {
    const provider = async () => "better-name.txt";
    renameSuggestionStore.setProvider(provider);
    const e = entry("a.txt");
    renameSuggestionStore.fetch(e);
    await flush();
    expect(renameSuggestionStore.suggestionFor(e.path)).toBe("better-name.txt");
    expect(renameSuggestionStore.suggestionFor("/other/path")).toBe(null);
    renameSuggestionStore.clearProvider(provider);
  });

  it("suppresses a suggestion equal to the current name", async () => {
    const provider = async () => "same.txt";
    renameSuggestionStore.setProvider(provider);
    const e = entry("same.txt");
    renameSuggestionStore.fetch(e);
    await flush();
    expect(renameSuggestionStore.suggestionFor(e.path)).toBe(null);
    renameSuggestionStore.clearProvider(provider);
  });

  it("ignores a late response after clear() ended the session", async () => {
    let release!: (v: string) => void;
    const provider = () => new Promise<string>((r) => (release = r));
    renameSuggestionStore.setProvider(provider);
    const e = entry("a.txt");
    renameSuggestionStore.fetch(e);
    renameSuggestionStore.clear(); // rename cancelled before the model replied
    release("late.txt");
    await flush();
    expect(renameSuggestionStore.suggestionFor(e.path)).toBe(null);
    renameSuggestionStore.clearProvider(provider);
  });

  it("a newer fetch supersedes an older in-flight one", async () => {
    const resolvers: Array<(v: string) => void> = [];
    const provider = () => new Promise<string>((r) => resolvers.push(r));
    renameSuggestionStore.setProvider(provider);
    const first = entry("first.txt");
    const second = entry("second.txt");
    renameSuggestionStore.fetch(first);
    renameSuggestionStore.fetch(second);
    resolvers[0]("stale-answer.txt");
    resolvers[1]("fresh-answer.txt");
    await flush();
    expect(renameSuggestionStore.suggestionFor(first.path)).toBe(null);
    expect(renameSuggestionStore.suggestionFor(second.path)).toBe("fresh-answer.txt");
    renameSuggestionStore.clearProvider(provider);
  });

  it("a provider failure stays silent", async () => {
    const provider = async (): Promise<string | null> => {
      throw new Error("model down");
    };
    renameSuggestionStore.setProvider(provider);
    const e = entry("a.txt");
    renameSuggestionStore.fetch(e);
    await flush();
    expect(renameSuggestionStore.suggestionFor(e.path)).toBe(null);
    expect(renameSuggestionStore.pending).toBe(false);
    renameSuggestionStore.clearProvider(provider);
  });

  it("clearProvider only removes the matching provider", async () => {
    const oldProvider = async () => "old.txt";
    const newProvider = async () => "new.txt";
    renameSuggestionStore.setProvider(oldProvider);
    renameSuggestionStore.setProvider(newProvider);
    renameSuggestionStore.clearProvider(oldProvider); // stale deactivate
    const e = entry("a.txt");
    renameSuggestionStore.fetch(e);
    await flush();
    expect(renameSuggestionStore.suggestionFor(e.path)).toBe("new.txt");
    renameSuggestionStore.clearProvider(newProvider);
  });
});
