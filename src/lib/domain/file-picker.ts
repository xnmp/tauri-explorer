/** Extension filters keep directories navigable and match files case-insensitively. */
export function matchesPickerExtensions(
  entry: { name: string; kind: string },
  extensions: readonly string[] = [],
): boolean {
  return entry.kind === "directory" || extensions.length === 0 ||
    extensions.some((extension) => entry.name.toLowerCase().endsWith(`.${extension.toLowerCase()}`));
}
