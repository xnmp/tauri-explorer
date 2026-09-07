import { expect, it, vi } from "vitest";
import { createWarmActivation } from "$lib/state/warm-activation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request = { path: "/requested", handoff: { sourceWindow: "main", requestId: "request" } };
function fixture() {
  const stop = vi.fn();
  const dependencies = {
    measure: false, acceptsActivation: vi.fn(() => true),
    listen: vi.fn(async (_handler: (payload: unknown) => Promise<void>) => stop),
    register: vi.fn(async () => true), refreshSettings: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}), prepare: vi.fn(async () => {}), show: vi.fn(async () => {}),
    focus: vi.fn(async () => {}), commit: vi.fn(async () => true),
    acknowledge: vi.fn(async () => {}), reject: vi.fn(async () => {}), retire: vi.fn(async () => {}),
    requestAddressBar: vi.fn(), shown: vi.fn(), reportError: vi.fn(),
  };
  const owner = createWarmActivation(dependencies);
  return { owner, dependencies, stop };
}

it("registers only after observation, and retires a late subscription", async () => {
  const { owner, dependencies, stop } = fixture();
  owner.dispose();
  await owner.ready;
  expect(stop).toHaveBeenCalledOnce();
  expect(dependencies.register).not.toHaveBeenCalled();
  expect(dependencies.retire).toHaveBeenCalledOnce();
  await dependencies.listen.mock.calls[0][0](request);
  expect(dependencies.show).not.toHaveBeenCalled();
});

it("acknowledges only after reveal, navigation and committed activation", async () => {
  const { owner, dependencies } = fixture();
  const navigation = deferred<void>();
  dependencies.navigate.mockReturnValue(navigation.promise);
  await owner.ready;
  const activating = owner.activate(request);
  await vi.waitFor(() => expect(dependencies.prepare).toHaveBeenCalledOnce());
  expect(dependencies.show).not.toHaveBeenCalled();
  expect(dependencies.acknowledge).not.toHaveBeenCalled();
  expect(dependencies.commit).not.toHaveBeenCalled();
  navigation.resolve();
  await activating;
  expect(dependencies.acknowledge).toHaveBeenCalledWith(request.handoff);
  expect(dependencies.commit.mock.invocationCallOrder[0]).toBeLessThan(dependencies.acknowledge.mock.invocationCallOrder[0]);
  expect(dependencies.requestAddressBar).toHaveBeenCalledOnce();
  owner.dispose();
  expect(dependencies.retire).not.toHaveBeenCalled();
});

for (const boundary of ["refreshSettings", "prepare", "show", "commit", "focus"] as const) {
  it(`retirement during ${boundary} suppresses subsequent native work and acknowledgement`, async () => {
    const { owner, dependencies } = fixture();
    const pending = deferred<any>();
    dependencies[boundary].mockReturnValue(pending.promise);
    await owner.ready;
    const activating = owner.activate(request);
    await vi.waitFor(() => expect(dependencies[boundary]).toHaveBeenCalledOnce());
    owner.dispose();
    pending.resolve(boundary === "commit" ? true : undefined);
    await activating;
    expect(dependencies.acknowledge).not.toHaveBeenCalled();
    expect(dependencies.requestAddressBar).not.toHaveBeenCalled();
    expect(dependencies.retire).toHaveBeenCalledOnce();
    if (boundary === "refreshSettings" || boundary === "prepare") expect(dependencies.show).not.toHaveBeenCalled();
  });
}

it("cannot reveal a window whose manager closes during settings refresh", async () => {
  const { owner, dependencies } = fixture();
  const pending = deferred<void>();
  dependencies.refreshSettings.mockReturnValue(pending.promise);
  await owner.ready;
  const activating = owner.activate(request);
  dependencies.acceptsActivation.mockReturnValue(false);
  pending.resolve();
  await activating;
  expect(dependencies.navigate).not.toHaveBeenCalled();
  expect(dependencies.show).not.toHaveBeenCalled();
  owner.dispose();
});

for (const boundary of ["show", "navigate", "commit"] as const) {
  it(`failed ${boundary} leaves the sender without a success and retires the destination`, async () => {
    const { owner, dependencies } = fixture();
    dependencies[boundary].mockRejectedValue(new Error("failed"));
    await owner.ready;
    await owner.activate(request);
    expect(dependencies.acknowledge).not.toHaveBeenCalled();
    expect(dependencies.retire).toHaveBeenCalledOnce();
    expect(dependencies.reportError).toHaveBeenCalledOnce();
    expect(dependencies.reject).toHaveBeenCalledWith(request.handoff);
  });
}

it("ignores malformed and uncorrelated requests without consuming the valid one", async () => {
  const { owner, dependencies } = fixture();
  await owner.ready;
  for (const raw of [null, { path: 5 }, { path: "/no-sender" }]) await owner.activate(raw);
  expect(dependencies.show).not.toHaveBeenCalled();
  await owner.activate(request);
  await owner.activate(request);
  expect(dependencies.show).toHaveBeenCalledOnce();
  expect(dependencies.acknowledge).toHaveBeenCalledOnce();
  owner.dispose();
});
