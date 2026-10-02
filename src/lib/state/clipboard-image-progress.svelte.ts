/** Image-paste work stays visible until its clipboard/write promise settles. */
interface ImagePaste {
  readonly id: number;
  readonly directory: string;
}

let nextId = 0;
let pending = $state<readonly ImagePaste[]>([]);

export const clipboardImageProgress = {
  get pending() { return pending; },
};

export async function withClipboardImageProgress<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const operation = { id: nextId++, directory };
  pending = [...pending, operation];
  try {
    return await work();
  } finally {
    pending = pending.filter(({ id }) => id !== operation.id);
  }
}
