/** Minimal DOM surface for drop contracts, matching the existing resolver
 * tests without introducing a browser environment dependency. */
export function dropElement(classes = "", attrs: Record<string, string> = {}, parent: HTMLElement | null = null): HTMLElement {
  const tokens = new Set(classes.split(" ").filter(Boolean));
  const matches = (selector: string) => {
    const requiredClasses = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    const requiredAttrs = [...selector.matchAll(/\[([\w-]+)(?:=['"]?([^\]'\"]+)['"]?)?\]/g)];
    return requiredClasses.every(name => tokens.has(name)) && requiredAttrs.every(([, name, value]) => name in attrs && (value === undefined || attrs[name] === value));
  };
  const element = {
    parentElement: parent,
    isConnected: true,
    classList: { add: (name: string) => tokens.add(name), remove: (name: string) => tokens.delete(name), contains: (name: string) => tokens.has(name) },
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string): HTMLElement | null => selector.split(",").some(part => matches(part.trim())) ? element as unknown as HTMLElement : parent?.closest(selector) ?? null,
  };
  return element as unknown as HTMLElement;
}
