/** Multi-token substring/subsequence matching shared by both Settings menus. */
export function matchesSettingsQuery(query: string, ...terms: string[]): boolean {
  const needle = query.toLowerCase().trim();
  if (!needle) return true;
  const haystack = terms.join(" ").toLowerCase();
  const isSubsequence = (token: string): boolean => {
    let i = 0;
    for (let j = 0; j < haystack.length && i < token.length; j++) {
      if (haystack[j] === token[i]) i++;
    }
    return i === token.length;
  };
  return needle.split(/\s+/).every(token => haystack.includes(token) || isSubsequence(token));
}
