import { afterEach, describe, expect, it, vi } from "vitest";
import { onSaveEffect } from "../src/save";

/** A `save` stand-in mirroring `useEdits`'s real one: the only thing that
 * ever touches the network is the PUT inside it. Asserting on the (globally
 * stubbed) `fetch`, not just on `save` itself, is what proves the write
 * path never started. */
function makeSave() {
  return vi.fn(async () => {
    await fetch("/api/overrides", { method: "PUT" });
  });
}

describe("onSaveEffect (PLAN 2026-08-04 fix wave, final review finding 1 + scoped re-review)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing on a CLEAN doc, even while a render is running — nothing to protect, nothing to notify", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const save = makeSave();
    const onBlocked = vi.fn();
    const onSaveError = vi.fn();
    onSaveEffect({ dirty: false, renderRunning: true, save, onBlocked, onSaveError });
    expect(save).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
    expect(onSaveError).not.toHaveBeenCalled();
  });

  it("blocks a DIRTY save while a render is running — via onBlocked, never onSaveError — and no PUT fires", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const save = makeSave();
    const onBlocked = vi.fn();
    const onSaveError = vi.fn();
    onSaveEffect({ dirty: true, renderRunning: true, save, onBlocked, onSaveError });
    expect(save).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    // The regression this guards: a block must NEVER go through the error
    // path — that's App.tsx's FATAL, full-screen, no-dismiss view.
    expect(onSaveError).not.toHaveBeenCalled();
  });

  it("saves normally when dirty and no render is running", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const save = makeSave();
    const onBlocked = vi.fn();
    const onSaveError = vi.fn();
    onSaveEffect({ dirty: true, renderRunning: false, save, onBlocked, onSaveError });
    await Promise.resolve(); // let the fire-and-forget `save()` microtask settle
    expect(save).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/overrides", { method: "PUT" });
    expect(onBlocked).not.toHaveBeenCalled();
    expect(onSaveError).not.toHaveBeenCalled();
  });
});
