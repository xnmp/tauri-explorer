/** Build-time environment needed to decide whether Tauri E2E hooks are present. */
export interface E2EModeEnvironment {
  DEV: boolean;
  VITE_TAURI_E2E?: string;
}

/**
 * Development has hooks by default. The embedded real-binary smoke build opts
 * in explicitly; ordinary production builds never include the hooks.
 */
export function isE2EMode(environment: E2EModeEnvironment): boolean {
  return environment.DEV || environment.VITE_TAURI_E2E === "1";
}

export const e2eMode = isE2EMode(import.meta.env);
