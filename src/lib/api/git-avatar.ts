import { invoke } from "@tauri-apps/api/core";

/** Best-effort avatar data; null means the caller keeps its local fallback. */
export async function gitAuthorAvatar(
  email: string,
  gravatarEnabled: boolean,
): Promise<string | null> {
  return invoke<string | null>("git_author_avatar", { email, gravatarEnabled });
}
