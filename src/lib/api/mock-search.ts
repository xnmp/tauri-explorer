/**
 * Mock search commands: fuzzy Quick Open, streaming name search and content search.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import { matchesPickerExtensions } from "$lib/domain/file-picker";
import { MOCK_LOCAL_KEYS } from "./mock-control";
import { mockFileContent, mockFiles } from "./mock-fixtures";
import type { SearchFilter } from "./search";
import type { CommandHandler } from "./mock-dispatch";
import { mockWrittenFiles } from "./mock-files";


export const searchCommands: Record<string, CommandHandler> = {

  fuzzy_search: (args) => {
    const query = (args.query as string).toLowerCase();
    // Browser mode falls back to this complete-result search when Tauri event
    // streaming is unavailable; record the same Quick Open search boundary as
    // `start_streaming_search` below.
    const calls = JSON.parse(localStorage.getItem(MOCK_LOCAL_KEYS.streamingSearches) ?? "[]") as Array<{
      query: string;
    }>;
    calls.push({ query: String(args.query ?? "") });
    localStorage.setItem(MOCK_LOCAL_KEYS.streamingSearches, JSON.stringify(calls));
    const root = (args.root as string) || "/home/user";
    const limit = args.limit as number || 20;
    const filter = args.filter as SearchFilter | undefined;
    const results: Array<{ name: string; path: string; relativePath: string; score: number; kind: "file" | "directory" }> = [];

    // Only search within directories that are under root (recursive)
    for (const [dirPath, entries] of Object.entries(mockFiles)) {
      if (!dirPath.startsWith(root)) continue;
      for (const entry of entries) {
        if (filter?.directoriesOnly && entry.kind !== "directory") continue;
        if (!matchesPickerExtensions(entry, filter?.extensions)) continue;
        if (entry.name.toLowerCase().includes(query)) {
          const relativePath = entry.path.startsWith(root + "/")
            ? entry.path.slice(root.length + 1)
            : entry.name;
          // Depth bonus: shallower matches score higher
          const depth = relativePath.split("/").length;
          const depthBonus = Math.max(0, 50 - (depth - 1) * 5);
          const dirBonus = entry.kind === "directory" ? 30 : 0;
          results.push({
            name: entry.name,
            path: entry.path,
            relativePath,
            score: 100 + depthBonus + dirBonus,
            kind: entry.kind,
          });
        }
      }
    }

    // Sort by score descending, then limit
    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, limit) };
  },

  start_streaming_search: (args) => {
    // Browser Quick Open regressions can assert the real component's IPC
    // boundary without replacing its search API. This stays mock-only: the
    // production backend never reads this diagnostic key.
    const calls = JSON.parse(localStorage.getItem(MOCK_LOCAL_KEYS.streamingSearches) ?? "[]") as Array<{
      query: string;
    }>;
    calls.push({ query: String(args.query ?? "") });
    localStorage.setItem(MOCK_LOCAL_KEYS.streamingSearches, JSON.stringify(calls));
    return 1; // Mock search ID
  },

  cancel_search: () => {},



  // Browser mode has no Tauri event system to stream results through, so the
  // mock searches the virtual filesystem synchronously and returns the
  // complete result set inline (the real backend returns a numeric search id
  // and streams via 'content-search-results' events).
  start_content_search: (args) => {
    const query = args.query as string;
    const root = (args.root as string) || "/home/user";
    const caseSensitive = (args.caseSensitive as boolean) ?? false;
    const regexMode = (args.regexMode as boolean) ?? false;
    const maxResults = (args.maxResults as number) ?? 500;

    if (!query) throw new Error("Search query cannot be empty");
    const pattern = regexMode ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try {
      re = new RegExp(pattern, caseSensitive ? "g" : "gi");
    } catch (e) {
      throw new Error(`Invalid search pattern: ${e}`);
    }

    const rootPrefix = root.endsWith("/") ? root : root + "/";
    const results: Array<{
      path: string;
      relativePath: string;
      matches: Array<{
        lineNumber: number;
        column: number;
        lineContent: string;
        matchStart: number;
        matchEnd: number;
      }>;
    }> = [];
    let filesSearched = 0;
    let totalMatches = 0;

    for (const [dirPath, entries] of Object.entries(mockFiles)) {
      if (dirPath !== root && !dirPath.startsWith(rootPrefix)) continue;
      for (const entry of entries) {
        if (entry.kind !== "file" || totalMatches >= maxResults) continue;
        const content = mockWrittenFiles[entry.path] ?? mockFileContent[entry.path];
        if (content === undefined) continue;
        filesSearched++;

        const matches: (typeof results)[number]["matches"] = [];
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(lines[i])) !== null) {
            matches.push({
              lineNumber: i + 1,
              column: m.index + 1,
              lineContent: lines[i],
              matchStart: m.index,
              matchEnd: m.index + m[0].length,
            });
            if (m[0].length === 0) re.lastIndex++;
          }
        }
        if (matches.length > 0) {
          totalMatches += matches.length;
          results.push({
            path: entry.path,
            relativePath: entry.path.startsWith(rootPrefix)
              ? entry.path.slice(rootPrefix.length)
              : entry.name,
            matches,
          });
        }
      }
    }

    return {
      searchId: 0,
      results,
      done: true,
      filesSearched,
      totalMatches,
    };
  },

  cancel_content_search: () => {},
};
