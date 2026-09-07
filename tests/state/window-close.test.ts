import { expect, it, vi } from "vitest";
import { createWindowClose } from "$lib/state/window-close";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const recover = vi.fn();
  const source = { destroy: vi.fn(async () => {}), onCloseRequested: vi.fn(async (_handler: (event: { preventDefault(): void }) => void) => () => {}) };
  const dependencies = { source: () => source, begin: vi.fn(() => recover), save: vi.fn(), reportError: vi.fn() };
  return { owner: createWindowClose(dependencies), source, dependencies, recover };
}

it("revokes admission synchronously and coalesces all accepted close requests", async () => {
  const { owner, source, dependencies } = setup();
  const retirement = deferred<void>();
  source.destroy.mockReturnValue(retirement.promise);
  const first = owner.request();
  expect(dependencies.begin).toHaveBeenCalledOnce();
  expect(owner.request()).toBe(first);
  await Promise.resolve();
  expect(source.destroy).toHaveBeenCalledOnce();
  expect(dependencies.save.mock.invocationCallOrder[0]).toBeLessThan(source.destroy.mock.invocationCallOrder[0]);
  retirement.resolve();
  expect(await first).toBe(true);
  expect(await owner.request()).toBe(true);
  expect(source.destroy).toHaveBeenCalledOnce();
});

for (const failure of ["save", "destroy"] as const) {
  it(`recovers admission and permits retry after ${failure} fails synchronously`, async () => {
    const { owner, source, dependencies, recover } = setup();
    (failure === "save" ? dependencies.save : source.destroy).mockImplementationOnce(() => { throw new Error("refused"); });
    expect(await owner.request()).toBe(false);
    expect(recover).toHaveBeenCalledOnce();
    expect(dependencies.reportError).toHaveBeenCalledOnce();
    expect(await owner.request()).toBe(true);
  });
}

it("does not reopen a disposed manager after native rejection", async () => {
  const { owner, source, recover } = setup();
  const retirement = deferred<void>();
  source.destroy.mockReturnValue(retirement.promise);
  const request = owner.request();
  await Promise.resolve();
  owner.dispose();
  retirement.reject(new Error("gone"));
  expect(await request).toBe(false);
  expect(recover).not.toHaveBeenCalled();
  expect(await owner.request()).toBe(false);
});

it("disposal before dispatch prevents native work", async () => {
  const { owner, source, dependencies } = setup();
  const request = owner.request();
  owner.dispose();
  expect(await request).toBe(false);
  expect(source.destroy).not.toHaveBeenCalled();
  expect(dependencies.save).not.toHaveBeenCalled();
});

it("retires late listeners without allowing queued callbacks to auto-destroy", async () => {
  const { owner, source, dependencies } = setup();
  const acquired = deferred<() => void>();
  source.onCloseRequested.mockReturnValueOnce(acquired.promise);
  const stop = owner.observe();
  const oldHandler = source.onCloseRequested.mock.calls[0][0];
  owner.observe();
  stop();
  const unlisten = vi.fn();
  acquired.resolve(unlisten);
  await Promise.resolve();
  expect(unlisten).toHaveBeenCalledOnce();
  const event = { preventDefault: vi.fn() };
  oldHandler(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(dependencies.begin).not.toHaveBeenCalled();
  source.onCloseRequested.mock.calls[1][0](event);
  expect(dependencies.begin).toHaveBeenCalledOnce();
  owner.dispose();
});
