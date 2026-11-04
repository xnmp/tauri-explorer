/**
 * AI filter (#1506) request owner. Lazy-loaded with `components/FilterBar.svelte`
 * so neither the prompt builder nor this controller enters the startup bundle.
 *
 * One controller per explorer. The explorer owns the listing predicate and
 * clears it on every filter reset (navigation, typing, close, reveal); the
 * predicate object this controller installed is therefore the staleness token
 * together with the request ID and the directory captured when the request
 * was issued. Nothing is sent unless the host text service reports the
 * default profile available at request time.
 */
import * as textApi from "$lib/api/ai-text";
import { extractError } from "$lib/api/common";
import { watchTextConnections } from "$lib/api/text-connections";
import {
  AI_FILTER_IDLE, AI_FILTER_MAX_OUTPUT_TOKENS, aiFilterOwnsListing, beginAiFilter, buildAiFilterPrompt,
  normalizeAiFilterQuery, parseAiFilterResponse, settleAiFilter, type AiFilterOutcome, type AiFilterState,
} from "$lib/domain/ai-filter";
import type { FileEntry } from "$lib/domain/file";

export type AiTextBackend = Pick<typeof textApi, "describeText" | "generateText" | "cancelText">;

/** The explorer surface the controller needs (structural, for tests). */
export interface AiFilterHost {
  readonly state: { readonly currentPath: string };
  readonly filterPredicate: ((entry: FileEntry) => boolean) | null;
  visibleEntries(): FileEntry[];
  setFilterPredicate(predicate: ((entry: FileEntry) => boolean) | null, select?: boolean): void;
}

export const AI_FILTER_UNAVAILABLE = "AI filter needs a language model. Set one up in Settings → AI.";

const showEverything = () => true;

export function createAiFilterController(
  host: AiFilterHost,
  backend: AiTextBackend = textApi,
  options: { now?: () => Date; requestId?: () => string; onAvailability?: (available: boolean) => void } = {},
) {
  const now = options.now ?? (() => new Date());
  const nextId = options.requestId ?? (() => `ai-filter-${crypto.randomUUID()}`);
  let raw = $state.raw<AiFilterState>(AI_FILTER_IDLE);
  let installed: ((entry: FileEntry) => boolean) | null = null;

  /** The state as the pane presents it: a cleared predicate or a moved pane ends it. */
  function current(): AiFilterState {
    if (raw.kind === "idle") return raw;
    if (raw.path !== host.state.currentPath) return AI_FILTER_IDLE;
    if (aiFilterOwnsListing(raw) && host.filterPredicate !== installed) return AI_FILTER_IDLE;
    return raw;
  }

  function install(predicate: ((entry: FileEntry) => boolean) | null, select = false) {
    installed = predicate;
    host.setFilterPredicate(predicate, select);
  }

  function abandon() {
    if (raw.kind === "loading") {
      const id = raw.requestId;
      void backend.cancelText(id).catch(() => undefined);
    }
  }

  async function run(query: string): Promise<void> {
    const request = normalizeAiFilterQuery(query);
    if (!request) return;
    abandon();
    const requestId = nextId();
    const path = host.state.currentPath;
    raw = beginAiFilter({ requestId, query: request, path });
    install(showEverything);
    const settle = (outcome: AiFilterOutcome) => {
      if (current() !== raw) return; // cleared, superseded or navigated
      const next = settleAiFilter(raw, requestId, host.state.currentPath, outcome);
      if (next === raw) return;
      raw = next;
      if (next.kind === "applied") {
        const names = next.names;
        install((entry) => names.has(entry.name), true);
      } else {
        // An error gives the listing back to the box's substring match.
        install(null);
      }
    };
    try {
      const description = await backend.describeText();
      options.onAvailability?.(description.available);
      if (!description.available) { settle({ ok: false, message: AI_FILTER_UNAVAILABLE }); return; }
      if (current() !== raw || raw.kind !== "loading" || raw.requestId !== requestId) return;
      const prompt = buildAiFilterPrompt(request, path, host.visibleEntries(), now());
      const result = await backend.generateText({
        requestId,
        instructions: prompt.instructions,
        input: prompt.input,
        maxOutputTokens: AI_FILTER_MAX_OUTPUT_TOKENS,
        expectedConfigurationRevision: description.configurationRevision,
      });
      const parsed = parseAiFilterResponse(result.text, prompt.sent);
      settle(parsed.ok
        ? { ok: true, names: parsed.names, sent: prompt.sent.length, total: prompt.total, truncated: prompt.truncated, ignored: parsed.ignored }
        : parsed);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "cancelled") return;
      settle({ ok: false, message: `AI filter failed: ${extractError(error)}` });
    }
  }

  /** Cancel or clear the AI filter, returning the listing to the box's text. */
  function clear() {
    abandon();
    const owned = aiFilterOwnsListing(current());
    raw = AI_FILTER_IDLE;
    if (owned) install(null);
    installed = null;
  }

  return {
    get state() { return current(); },
    run,
    clear,
  };
}

export type AiFilterController = ReturnType<typeof createAiFilterController>;

// ---- Per-explorer controllers and availability -----------------------------

const controllers = new WeakMap<AiFilterHost, AiFilterController>();

export function aiFilterFor(host: AiFilterHost): AiFilterController {
  let controller = controllers.get(host);
  if (!controller) {
    controller = createAiFilterController(host, textApi, { onAvailability: (available) => { availability = available; } });
    controllers.set(host, controller);
  }
  return controller;
}

/** Whether the default text profile is usable; null until first described. */
let availability = $state<boolean | null>(null);
let watching = false;
let describing: Promise<void> | null = null;

export function refreshAiTextAvailability(backend: Pick<AiTextBackend, "describeText"> = textApi): Promise<void> {
  if (!watching) {
    watching = true;
    void watchTextConnections(() => { describing = null; void refreshAiTextAvailability(backend); }).catch(() => { watching = false; });
  }
  describing ??= backend.describeText()
    .then((description) => { availability = description.available; })
    .catch(() => { availability = false; })
    .finally(() => { describing = null; });
  return describing;
}

export const aiTextAvailability = {
  get available() { return availability === true; },
};
