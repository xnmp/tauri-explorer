/**
 * Shell command construction for the embedded terminal's explicit
 * "sync to current folder" action (issue #139). Pure and unit-tested —
 * quoting bugs here would execute in the user's real shell.
 */

/** POSIX single-quote: safe for any bytes except the quote itself, which is
 *  closed-escaped-reopened ('\''). */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The line written to the PTY to change the shell's directory to `path`
 * (including the terminating carriage return xterm sends for Enter).
 * Windows targets cmd.exe (`/d` switches drive too, quotes handle spaces;
 * COMSPEC is the spawned shell there); elsewhere POSIX quoting covers
 * spaces, quotes, and globs for sh/bash/zsh/fish.
 *
 * cmd.exe `%VAR%` caveat: at the interactive command line cmd.exe expands
 * `%VAR%` references even inside double quotes, and — unlike batch files —
 * there is NO reliable escape (`%%` only collapses in batch scripts; a caret
 * is not processed inside quotes). See the sources below. We deliberately do
 * NOT attempt a fragile escape: shipping a wrong one would corrupt correct
 * paths. The common cases are already safe because cmd.exe leaves a percent
 * sequence LITERAL when it isn't a defined variable — a lone `%`, or `%NAME%`
 * where NAME is undefined, both pass through unchanged. The only unhandled
 * case is a directory whose name literally contains `%NAME%` for a NAME that
 * happens to be a *defined* environment variable (very rare on real systems).
 * TODO(#154): revisit if a robust interactive-cmd escaping technique emerges,
 * or switch the Windows sync shell to PowerShell (which quotes `%` cleanly).
 *   https://ss64.com/nt/syntax-percent.html
 *   https://ss64.com/nt/syntax-esc.html
 */
export function buildCdCommand(path: string, isWindows: boolean): string {
  if (isWindows) {
    return `cd /d "${path}"\r`;
  }
  return `cd ${shellSingleQuote(path)}\r`;
}

/**
 * The full PTY write for an automatic cd sync: a clear-line control byte
 * (so the injected cd wins over any half-typed prompt input) followed by
 * the cd command. The clear byte is shell-family-specific: Ctrl+U (0x15)
 * is readline/zsh kill-line, but cmd.exe/PowerShell don't interpret it —
 * they'd receive a stray NAK that corrupts the command line (#150). Both
 * Windows shells clear console line input on ESC (0x1b).
 */
export function buildCdSyncSequence(path: string, isWindows: boolean): string {
  const clearLine = isWindows ? "\x1b" : "\x15";
  return clearLine + buildCdCommand(path, isWindows);
}
