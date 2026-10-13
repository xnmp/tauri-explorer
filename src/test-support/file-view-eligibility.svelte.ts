/** Browser-only fixture imported by the intercepted demo module in E2E.
 * No production import; use the real registry, context and pane renderer. */
import type { FileViewEligibility } from "$lib/plugins/api";

let answers = $state.raw<ReadonlyMap<string, FileViewEligibility>>(new Map());
let finishActivation!: () => void;
export const activation = new Promise<void>((resolve) => { finishActivation = resolve; });
export function releaseActivation(): void { finishActivation(); }
export function available(directory: string): FileViewEligibility {
  return answers.get(directory) ?? "pending";
}
export function answer(directory: string, value: boolean): void {
  answers = new Map(answers).set(directory, value);
}
