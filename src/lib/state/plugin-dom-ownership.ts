import type { Component } from "svelte";

/** Host-issued component identities define ownership, never DOM attributes or
 * plugin-provided selectors. The nearest mounted contribution wins. */
const owners = new WeakMap<Element | Component<any>, symbol>();
export const pluginDomOwnership = {
  contribute(component: Component<any>, owner: symbol): void { owners.set(component, owner); },
  mount(root: HTMLElement, component: Component<any>): { destroy(): void } {
    owners.set(root, owners.get(component)!);
    return { destroy: () => { owners.delete(root); } };
  },
  owns(element: HTMLElement, owner: symbol): boolean {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const actual = owners.get(node);
      if (actual) return actual === owner;
    }
    return false;
  },
};
