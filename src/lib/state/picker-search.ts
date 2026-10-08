import type { SearchResult } from "$lib/api/search";
import { createQuickOpenSearchScheduler } from "$lib/domain/quick-open-search";

/** Owns delayed searches; new input and closure synchronously revoke old results. */
export function createPickerSearch({ local, search, publish }: {
  local: (query: string, remote?: readonly SearchResult[]) => SearchResult[];
  search: (query: string) => Promise<readonly SearchResult[]>;
  publish: (results: SearchResult[]) => void;
}) {
  let revision = 0;
  const scheduler = createQuickOpenSearchScheduler(query => {
    const started = revision;
    void search(query).then(remote => {
      if (revision === started) publish(local(query, remote));
    }).catch(() => { /* Keep immediate local results on backend failure. */ });
  });
  function cancel() { revision++; scheduler.cancel(); }
  return {
    update(query: string) {
      cancel();
      publish(local(query));
      if (query.trim()) scheduler.schedule(query);
    },
    cancel,
  };
}
