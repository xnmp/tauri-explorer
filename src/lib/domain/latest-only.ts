/**
 * Runs async tasks one at a time, keeping only the newest waiting task (#1054).
 *
 * Backend work that cannot be cancelled once started — a Preview rendition
 * decode — would otherwise queue one job per skipped selection while an arrow
 * key repeats, and the selection the user stops on would wait behind all of
 * them. Here at most one task runs; a task that arrives while it runs replaces
 * any task already waiting, and the replaced one resolves `SKIPPED` without
 * starting. A task whose `isWanted()` is false when its turn comes is skipped
 * too.
 */

export const SKIPPED: unique symbol = Symbol("skipped");
export type Skipped = typeof SKIPPED;

export interface LatestOnlyRunner {
  run<T>(task: () => Promise<T>, isWanted: () => boolean): Promise<T | Skipped>;
}

interface Waiting {
  start(): void;
  skip(): void;
}

export function createLatestOnlyRunner(): LatestOnlyRunner {
  let running = false;
  let waiting: Waiting | null = null;

  function startNext(): void {
    running = false;
    const next = waiting;
    waiting = null;
    next?.start();
  }

  return {
    run<T>(task: () => Promise<T>, isWanted: () => boolean): Promise<T | Skipped> {
      return new Promise<T | Skipped>((resolve, reject) => {
        const entry: Waiting = {
          start() {
            if (!isWanted()) {
              resolve(SKIPPED);
              startNext();
              return;
            }
            running = true;
            Promise.resolve()
              .then(task)
              .then(resolve, reject)
              .finally(startNext);
          },
          skip() {
            resolve(SKIPPED);
          },
        };
        if (running) {
          waiting?.skip();
          waiting = entry;
        } else {
          entry.start();
        }
      });
    },
  };
}
