import "svelte/elements";

// WebKit honours `autocorrect` on <textarea> as well as <input>, but Svelte only
// types it for <input>. Declared here so textareas can suppress the macOS
// correction bubble (#1726).
declare module "svelte/elements" {
  interface HTMLTextareaAttributes {
    autocorrect?: "on" | "off" | null | undefined;
  }
}

export {};
