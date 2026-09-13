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
