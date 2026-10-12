import { expect, it, vi } from "vitest";
import { createPaneDialogFocusRestore } from "$lib/state/modal-focus";
import { createModalOwnership } from "$lib/state/modal-ownership.svelte";

function fixture(previousPane = "b") {
  const document = new EventTarget() as EventTarget & { body: HTMLElement; activeElement: HTMLElement };
  function element(paneId?: string): HTMLElement {
    const node = {
      ownerDocument: document, isConnected: true, offsetParent: {},
      closest: (selector: string) => selector === "[data-pane-id]" && paneId
        ? { getAttribute: () => paneId } : null,
      matches: () => false,
      focus: vi.fn(() => {
        document.activeElement = node as unknown as HTMLElement;
        const event = new Event("focusin");
        Object.defineProperty(event, "target", { value: node });
        document.dispatchEvent(event);
      }),
    };
    return node as unknown as HTMLElement;
  }
  document.body = element();
  const previous = element(previousPane), pane = element("a"), editor = element();
  const ref = Object.assign(element(), { contains: (node: unknown) => node === editor });
  document.activeElement = previous;
  let active = true;
  const ownership = createModalOwnership();
  const focusUncovered = vi.fn(() => pane.focus());
  const close = createPaneDialogFocusRestore(ref, previous, "a", {
    isActive: () => active, isUncovered: () => !ownership.hasOpen && !ownership.hasPaneOpen("a"), focusUncovered,
  });
  editor.focus();
  return {
    document, previous, pane, editor, ref, close, focusUncovered, ownership,
    deactivate: () => { active = false; },
    detach: () => {
      Object.assign(ref, { isConnected: false });
      Object.assign(editor, { isConnected: false });
      if (ref.contains(document.activeElement)) document.activeElement = document.body;
    },
  };
}

it("a captured A opening restores A after focused dialog DOM is removed before cleanup", async () => {
  const f = fixture();
  f.detach(); f.close();
  await Promise.resolve();
  expect(f.document.activeElement).toBe(f.pane);
  expect(f.previous.focus).not.toHaveBeenCalled();
});

it("restores an available previous A control instead of the pane fallback", async () => {
  const f = fixture("a");
  f.detach(); f.close();
  await Promise.resolve();
  expect(f.document.activeElement).toBe(f.previous);
  expect(f.focusUncovered).not.toHaveBeenCalled();
});

it("does not restore when another pane owns focus before dialog removal", async () => {
  const f = fixture();
  f.previous.focus(); f.detach(); f.close();
  await Promise.resolve();
  expect(f.document.activeElement).toBe(f.previous);
  expect(f.focusUncovered).not.toHaveBeenCalled();
});

it("an explicit blur to body does not count as focus lost through DOM removal", async () => {
  const f = fixture();
  const event = new Event("focusout");
  Object.defineProperties(event, { target: { value: f.editor }, relatedTarget: { value: null } });
  f.document.dispatchEvent(event);
  f.document.activeElement = f.document.body;
  f.detach(); f.close();
  await Promise.resolve();
  expect(f.focusUncovered).not.toHaveBeenCalled();
});

it("does not restore after owner retirement or a tab/pane switch during cleanup", async () => {
  const f = fixture();
  f.close(); f.deactivate(); f.detach();
  await Promise.resolve();
  expect(f.focusUncovered).not.toHaveBeenCalled();
});

it("a new focus target during ownership release keeps focus", async () => {
  const f = fixture();
  f.close(); f.detach(); f.previous.focus();
  await Promise.resolve();
  expect(f.document.activeElement).toBe(f.previous);
  expect(f.focusUncovered).not.toHaveBeenCalled();
});

it.each(["window", "pane"])("a new %s reservation before restoration retains ownership", async scope => {
  const f = fixture("a");
  f.close(); f.detach();
  f.ownership.register(() => {}, undefined, {
    scope: scope === "window" ? null : { paneId: "a", token: Symbol() },
  });
  await Promise.resolve();
  expect(f.document.activeElement).toBe(f.document.body);
  expect(f.previous.focus).not.toHaveBeenCalled();
  expect(f.focusUncovered).not.toHaveBeenCalled();
});
