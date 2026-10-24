/**
 * Settings display of terminal line-editing bindings (#375). Kept out of
 * `terminal-keys.ts`, which is in the startup bundle, because only the
 * lazily loaded Settings dialog uses it (#1372).
 */

/** The binding Settings shows for one action: a user override wins (an
 *  empty override means disabled); otherwise the platform default, if any. */
export function terminalBindingFor(
  actionId: string,
  user: Record<string, string>,
  defaults: Record<string, string>,
): { binding: string; isDefault: boolean } {
  const override = user[actionId];
  if (override !== undefined) return { binding: override, isDefault: false };
  return { binding: defaults[actionId] ?? "", isDefault: true };
}
