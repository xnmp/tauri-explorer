/**
 * How a file-list entry presents its Git status (#1852): the tone that tints
 * its name, the letter chip beside it, and whether the name is dimmed.
 *
 * Colours are theme variables (`--git-<tone>`, defaults in
 * `themes/git-status.css`), so this module only names them.
 */
import { gitStatusLetter, type GitStatusCode } from "./git";

/** One colour per status; each is a `--git-<tone>` theme variable. */
export type GitStatusTone =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "conflicted"
  | "renamed"
  | "copied"
  | "typechange"
  | "ignored";

export interface GitStatusPresentation {
  readonly status: GitStatusCode;
  readonly tone: GitStatusTone;
  /** CSS colour value: the tone's theme variable. */
  readonly color: string;
  /** The chip's letter; null for ignored entries, which show no chip. */
  readonly letter: string | null;
  /** The name is dimmed (ignored) instead of tinted. */
  readonly dimmed: boolean;
  /** The chip carries extra emphasis (conflicts need attention). */
  readonly emphasis: boolean;
}

const TONES: Readonly<Record<GitStatusCode, GitStatusTone>> = {
  Modified: "modified",
  Added: "added",
  Untracked: "untracked",
  Deleted: "deleted",
  Conflicted: "conflicted",
  Renamed: "renamed",
  Copied: "copied",
  TypeChange: "typechange",
  Ignored: "ignored",
};

const PRESENTATIONS = new Map<GitStatusCode, GitStatusPresentation>(
  (Object.keys(TONES) as GitStatusCode[]).map((status) => {
    const tone = TONES[status];
    return [status, Object.freeze({
      status,
      tone,
      color: `var(--git-${tone})`,
      letter: status === "Ignored" ? null : gitStatusLetter(status),
      dimmed: status === "Ignored",
      emphasis: status === "Conflicted",
    })];
  }),
);

/**
 * The presentation of `status`, or null when the entry is clean. An unknown
 * status (a newer backend) is treated as clean rather than guessed at.
 * Results are shared frozen objects, so rows compare and allocate nothing.
 */
export function gitStatusPresentation(status: string | null | undefined): GitStatusPresentation | null {
  return status ? PRESENTATIONS.get(status as GitStatusCode) ?? null : null;
}
