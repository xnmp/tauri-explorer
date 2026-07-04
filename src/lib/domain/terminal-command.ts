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
