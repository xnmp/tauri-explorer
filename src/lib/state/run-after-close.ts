import { tick } from "svelte";

/** Runs a command chosen from a modal launcher (the command palette) only
 * after the launcher has retired its modal surface.
 *
 * A managed dialog binds its caller to the top modal surface when it opens
 * (`modalOwnership.onCallerClosed`). Modal releases its surface in an effect
 * cleanup that Svelte flushes on the next tick, so a command run straight
 * after `close()` would bind the dialog to the closing launcher, and the
 * dialog would close ("caller-closed") as the launcher let go. */
export async function runAfterClose(
  close: () => void,
  run: () => Promise<unknown>,
  settled: () => Promise<void> = tick,
): Promise<void> {
  close();
  await settled();
  await run();
}
