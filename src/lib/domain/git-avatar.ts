/** Persisted Git Graph avatar preferences. Display and third-party consent are separate. */
export interface GitAvatarPreferences {
  visible: boolean;
  gravatarEnabled: boolean;
}

/** The stable identity used by both the fallback and remote image lookup. */
export interface GitAvatarAuthor {
  name: string;
  email: string;
}

export interface GitAvatarFallback {
  initial: string;
  color: string;
}

const AVATAR_COLORS = ["#2563eb", "#7c3aed", "#c026d3", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#4f46e5", "#9333ea", "#0d9488"] as const;

/** Pure, deterministic fallback used before and after best-effort lookup. */
export function avatarFallback(author: GitAvatarAuthor): GitAvatarFallback {
  const name = author.name.trim();
  const email = author.email.trim().toLocaleLowerCase("en-US");
  const identity = `${name.toLocaleLowerCase("en-US")}\0${email}`;
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return {
    initial: (name || email).charAt(0).toLocaleUpperCase("en-US") || "?",
    color: AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length],
  };
}
