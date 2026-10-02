/**
 * Keybindings state management for customizable hotkeys.
 * Issue: tauri-explorer-npjh.4
 *
 * Manages user-customizable keyboard shortcuts with localStorage persistence.
 * Each command can have a custom shortcut that overrides the default.
 */

import {
  matchesShortcutString,
  matchesShortcut,
  formatShortcut,
  isChordShortcut,
  parseChord,
  type ParsedChord,
} from "$lib/domain/keybinding-parser";
import { loadPersisted, savePersisted } from "./persisted";
import { shortcutsConflict } from "$lib/domain/shortcut-conflicts";
import { isModifierKey } from "$lib/domain/keyboard";
import { CHORD_TIMEOUT_MS } from "$lib/domain/shortcut-recording";

/** A single keybinding entry */
export interface Keybinding {
  commandId: string;
  defaultShortcut: string;
  userShortcut: string | null; // null means explicitly unbound (or no override in getAllBindings)
}

/** Map of command ID to user's custom shortcut (null = explicitly unbound) */
export type UserKeybindings = Record<string, string | null>;

const STORAGE_KEY = "explorer-keybindings";

/** Default shortcuts defined by commands */
let defaultShortcuts = $state<Record<string, string>>({});

/** User's custom shortcuts (overrides defaults) */
let userShortcuts = $state<UserKeybindings>({});

/** Chord state: when a prefix key is pressed, we wait for the suffix */
let activeChordPrefix = $state<string | null>(null);
let activeChordCommandIds = $state<string[] | null>(null);
let chordTimeoutId: ReturnType<typeof setTimeout> | null = null;

/** WebKitGTK maps only GDK_META_MASK into event.metaKey — the Super/Mod4
 * modifier (the Linux "Cmd") never sets it, so Cmd+… bindings could not fire
 * in the real Linux app (#244). The Super KEY itself does arrive as a
 * keydown/keyup (key "Super"/"Meta"/"OS"), so its held state is tracked here
 * and overlaid as the meta modifier during matching. Not $state: read only
 * inside event handling, never rendered. */
let superKeyHeld = false;

function isSuperKeyEvent(event: KeyboardEvent): boolean {
  return event.key === "Super" || event.key === "Meta" || event.key === "OS";
}

function loadUserShortcuts(): UserKeybindings {
  return loadPersisted(STORAGE_KEY, {});
}

function saveUserShortcuts(): void {
  // Reset deletes an override. Null must survive restart to keep a command
  // explicitly unbound, including every binding displaced by an override.
  savePersisted(STORAGE_KEY, userShortcuts);
}

/**
 * Create the keybindings store.
 */
function createKeybindingsStore() {
  // Load saved shortcuts on initialization
  userShortcuts = loadUserShortcuts();

  /**
   * Register a command's default shortcut.
   * Called during command registration.
   */
  function registerDefault(commandId: string, shortcut: string): void {
    defaultShortcuts[commandId] = shortcut;
  }

  /**
   * Register multiple default shortcuts at once.
   */
  function registerDefaults(shortcuts: Record<string, string>): void {
    defaultShortcuts = { ...defaultShortcuts, ...shortcuts };
  }

  /**
   * Get the effective shortcut for a command (user override or default).
   */
  function getShortcut(commandId: string): string | undefined {
    // User override takes precedence
    if (commandId in userShortcuts) {
      const userShortcut = userShortcuts[commandId];
      // null means explicitly unbound
      if (userShortcut === null) return undefined;
      return userShortcut;
    }
    // Fall back to default
    return defaultShortcuts[commandId];
  }

  /**
   * Get the formatted display string for a command's shortcut.
   */
  function getDisplayShortcut(commandId: string): string | undefined {
    const shortcut = getShortcut(commandId);
    return shortcut ? formatShortcut(shortcut) : undefined;
  }

  /**
   * Set a custom shortcut for a command.
   * Pass null to unbind the command.
   */
  function setShortcut(commandId: string, shortcut: string | null): void {
    setShortcuts({ [commandId]: shortcut });
  }

  /** Publish an import or explicit override atomically, with no intermediate conflicts. */
  function setShortcuts(shortcuts: UserKeybindings): void {
    cancelChord();
    userShortcuts = { ...userShortcuts, ...shortcuts };
    for (const commandId of Object.keys(shortcuts)) chordCache.delete(commandId);
    saveUserShortcuts();
  }

  /**
   * Reset a command to its default shortcut.
   */
  function resetToDefault(commandId: string): void {
    const { [commandId]: _, ...rest } = userShortcuts;
    userShortcuts = rest;
    chordCache.delete(commandId); // effective shortcut changed
    saveUserShortcuts();
  }

  /**
   * Reset all shortcuts to defaults.
   */
  function resetAllToDefaults(): void {
    userShortcuts = {};
    chordCache.clear();
    saveUserShortcuts();
  }

  /**
   * Check if a command has a custom shortcut.
   */
  function hasCustomShortcut(commandId: string): boolean {
    return commandId in userShortcuts;
  }

  /**
   * Get all keybindings (for UI display).
   */
  function getAllBindings(): Keybinding[] {
    return Object.keys(defaultShortcuts).map((commandId) => ({
      commandId,
      defaultShortcut: defaultShortcuts[commandId],
      userShortcut: userShortcuts[commandId] ?? null,
    }));
  }

  /** Cancel active chord waiting state */
  function cancelChord(): void {
    activeChordPrefix = null;
    activeChordCommandIds = null;
    if (chordTimeoutId) {
      clearTimeout(chordTimeoutId);
      chordTimeoutId = null;
    }
  }

  /** Cache of parsed chord shortcuts (built lazily, invalidated on rebind) */
  const chordCache = new Map<string, ParsedChord>();

  function getChordForCommand(commandId: string): ParsedChord | null {
    const shortcut = getShortcut(commandId);
    if (!shortcut || !isChordShortcut(shortcut)) return null;

    if (chordCache.has(commandId)) return chordCache.get(commandId)!;
    const parsed = parseChord(shortcut);
    if (parsed) chordCache.set(commandId, parsed);
    return parsed;
  }

  /**
   * Find which command matches a keyboard event.
   * Returns the command ID if found, undefined otherwise.
   * Returns "chord:waiting" if a chord prefix was matched and we're waiting for suffix.
   * Optionally accepts a predicate to skip commands that aren't currently available.
   */
  function findMatchingCommand(
    event: KeyboardEvent,
    isAvailable?: (commandId: string) => boolean,
  ): string | undefined {
    const matchOpts = superKeyHeld && !event.metaKey ? { metaHeld: true } : undefined;

    // Modifiers and held-key repeats never start or finish a chord, and do
    // not renew its deadline. Ordinary single-key shortcuts retain repeats.
    if (isModifierKey(event.key) || (event.repeat && activeChordCommandIds !== null)) return undefined;

    // If we're in chord-waiting mode, check suffix keys
    if (activeChordCommandIds !== null) {
      const commandIds = activeChordCommandIds;
      cancelChord();

      for (const commandId of commandIds) {
        const shortcut = getShortcut(commandId);
        if (!shortcut || !isChordShortcut(shortcut)) continue;

        const chord = getChordForCommand(commandId);
        if (!chord) continue;

        // This command's prefix was already matched; now check its suffix.
        if (matchesShortcut(event, chord.suffix, matchOpts)) {
          if (!isAvailable || isAvailable(commandId)) {
            return commandId;
          }
        }
      }
      // Suffix didn't match any chord — fall through to normal matching
      return undefined;
    }

    // Check chord prefixes first. Keep each eligible command identity so
    // terminal focus can safely distinguish colliding chord suffixes.
    const matchingChordCommandIds: string[] = [];
    for (const commandId of Object.keys(defaultShortcuts)) {
      const chord = getChordForCommand(commandId);
      if (!chord || event.repeat) continue;

      if (matchesShortcut(event, chord.prefix, matchOpts)) {
        if (!isAvailable || isAvailable(commandId)) {
          matchingChordCommandIds.push(commandId);
        }
      }
    }
    if (matchingChordCommandIds.length > 0) {
      const shortcut = getShortcut(matchingChordCommandIds[0])!;
      activeChordPrefix = shortcut.substring(0, shortcut.indexOf(" ")).trim();
      activeChordCommandIds = matchingChordCommandIds;
      chordTimeoutId = setTimeout(cancelChord, CHORD_TIMEOUT_MS);
      return "chord:waiting";
    }

    // Normal single-key shortcut matching
    for (const commandId of Object.keys(defaultShortcuts)) {
      const shortcut = getShortcut(commandId);
      if (shortcut && matchesShortcutString(event, shortcut, matchOpts)) {
        if (!isAvailable || isAvailable(commandId)) {
          return commandId;
        }
      }
    }
    return undefined;
  }

  /**
   * Side-effect-free variant of findMatchingCommand: does this event match
   * any bound shortcut or chord prefix? Used by the terminal gates (#260) to
   * decide key ownership WITHOUT entering chord-waiting mode.
   *
   * `isAvailable` (optional) applies the same `when` guards `findMatchingCommand`
   * uses. Pass it wherever the answer decides whether the SHELL gets the key:
   * a command that can't run right now doesn't own its shortcut, and claiming
   * it anyway swallows the keystroke — nothing runs and the shell never sees
   * it. Ctrl+Up/Down (#530, graph-pane-gated) is the case that exposed this:
   * unguarded, it would silently kill readline history-substring-search in the
   * terminal for every user whose active pane isn't a commit graph.
   */
  function matchesAnyBinding(
    event: KeyboardEvent,
    isAvailable?: (commandId: string) => boolean,
  ): boolean {
    const matchOpts = superKeyHeld && !event.metaKey ? { metaHeld: true } : undefined;
    for (const commandId of Object.keys(defaultShortcuts)) {
      const chord = getChordForCommand(commandId);
      if (chord) {
        if (matchesShortcut(event, chord.prefix, matchOpts)) {
          if (!isAvailable || isAvailable(commandId)) return true;
        }
        continue;
      }
      const shortcut = getShortcut(commandId);
      if (shortcut && matchesShortcutString(event, shortcut, matchOpts)) {
        if (!isAvailable || isAvailable(commandId)) return true;
      }
    }
    return false;
  }

  /**
   * Whether this event is the prefix of one specific configured chord.
   *
   * Terminal input ownership uses this to grant a deliberately narrow
   * exception without allowing every Explorer chord to consume shell input.
   */
  function matchesChordPrefixForCommand(event: KeyboardEvent, commandId: string): boolean {
    const chord = getChordForCommand(commandId);
    if (!chord) return false;
    const matchOpts = superKeyHeld && !event.metaKey ? { metaHeld: true } : undefined;
    return matchesShortcut(event, chord.prefix, matchOpts);
  }

  /** Whether this event completes one specific active chord. */
  function isChordActiveForCommand(event: KeyboardEvent, commandId: string): boolean {
    if (!activeChordCommandIds?.includes(commandId)) return false;
    const chord = getChordForCommand(commandId);
    if (!chord) return false;
    const matchOpts = superKeyHeld && !event.metaKey ? { metaHeld: true } : undefined;
    return matchesShortcut(event, chord.suffix, matchOpts);
  }

  /** Side-effect-free ownership check for configured chord prefixes. */
  function matchesAnyChordPrefix(event: KeyboardEvent, isAvailable?: (id: string) => boolean): boolean {
    return !event.repeat && Object.keys(defaultShortcuts).some((id) =>
      (!isAvailable || isAvailable(id)) && matchesChordPrefixForCommand(event, id));
  }

  /**
   * Check for shortcut conflicts.
   * Returns command IDs that would conflict with the given shortcut.
   */
  function findConflicts(shortcut: string, excludeCommandId?: string): string[] {
    const conflicts: string[] = [];

    for (const commandId of Object.keys(defaultShortcuts)) {
      if (commandId === excludeCommandId) continue;

      const existingShortcut = getShortcut(commandId);
      if (existingShortcut && shortcutsConflict(existingShortcut, shortcut)) {
        conflicts.push(commandId);
      }
    }

    return conflicts;
  }

  /**
   * Clear all data for testing purposes.
   * @internal
   */
  function _clearForTesting(): void {
    defaultShortcuts = {};
    userShortcuts = {};
    chordCache.clear();
    cancelChord();
  }

  /** Track Super-key held state from window keydown/keyup (see superKeyHeld). */
  function trackModifierKey(event: KeyboardEvent, down: boolean): void {
    if (isSuperKeyEvent(event)) superKeyHeld = down;
  }

  /** Clear tracked modifier state (window blur — keyups can be lost). */
  function resetTrackedModifiers(): void {
    superKeyHeld = false;
  }

  return {
    trackModifierKey,
    resetTrackedModifiers,
    /** Same Super overlay used by shortcut matching on WebKitGTK. */
    get trackedMetaHeld() { return superKeyHeld; },
    registerDefault,
    registerDefaults,
    getShortcut,
    getDisplayShortcut,
    setShortcut,
    setShortcuts,
    resetToDefault,
    resetAllToDefaults,
    hasCustomShortcut,
    getAllBindings,
    findMatchingCommand,
    matchesAnyBinding,
    matchesAnyChordPrefix,
    matchesChordPrefixForCommand,
    isChordActiveForCommand,
    findConflicts,
    cancelChord,
    _clearForTesting,

    /** Whether a chord prefix is active (waiting for suffix key) */
    get isChordActive() {
      return activeChordCommandIds !== null;
    },

    /** The active chord prefix string (for status bar display) */
    get activeChordPrefix() {
      return activeChordPrefix;
    },

    /** Get the raw user shortcuts (for debugging/inspection) */
    get userShortcuts() {
      return { ...userShortcuts };
    },

    /** Get the raw default shortcuts (for debugging/inspection) */
    get defaultShortcuts() {
      return { ...defaultShortcuts };
    },
  };
}

export const keybindingsStore = createKeybindingsStore();
