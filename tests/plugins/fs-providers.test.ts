/**
 * Virtual-fs provider registry + dispatch (src/lib/plugins/fs-providers.ts).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { DirectoryListing } from "$lib/domain/file";
import {
  registerFsProvider,
  providerFor,
  clearFsProviders,
  type FsProvider,
} from "$lib/plugins/fs-providers";

function listing(path: string): DirectoryListing {
  return { path, entries: [], listing_id: null };
}

describe("fs-provider dispatch", () => {
  beforeEach(() => clearFsProviders());

  it("matches a registered provider by scheme prefix", () => {
    const provider: FsProvider = { list: (p) => listing(p) };
    registerFsProvider("demo", provider);
    expect(providerFor("demo://a/b")).toBe(provider);
    expect(providerFor("demo://")).toBe(provider);
  });

  it("is case-insensitive on the scheme", () => {
    const provider: FsProvider = { list: (p) => listing(p) };
    registerFsProvider("Demo", provider);
    expect(providerFor("demo://x")).toBe(provider);
    expect(providerFor("DEMO://x")).toBe(provider);
  });

  it("returns null for unmatched schemes and real paths (passthrough)", () => {
    registerFsProvider("demo", { list: (p) => listing(p) });
    expect(providerFor("keep://x")).toBeNull();
    expect(providerFor("/home/user")).toBeNull();
    expect(providerFor("C:/Users")).toBeNull();
  });

  it("disposer unregisters only its own provider", () => {
    const a: FsProvider = { list: (p) => listing(p) };
    const b: FsProvider = { list: (p) => listing(p) };
    const disposeA = registerFsProvider("demo", a);
    // Re-registering the same scheme replaces the provider.
    registerFsProvider("demo", b);
    // A's disposer must NOT remove B (the current provider).
    disposeA();
    expect(providerFor("demo://x")).toBe(b);
  });

  it("last registration for a scheme wins", () => {
    const a: FsProvider = { list: (p) => listing(p) };
    const b: FsProvider = { list: (p) => listing(p) };
    registerFsProvider("demo", a);
    registerFsProvider("demo", b);
    expect(providerFor("demo://x")).toBe(b);
  });
});
