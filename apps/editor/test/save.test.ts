import { afterEach, describe, expect, it, vi } from "vitest";
import { guardedSave } from "../src/save";

describe("guardedSave (PLAN 2026-08-04 fix wave, final review finding 1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to save while a render is running — no PUT reaches fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Mirrors `useEdits`'s real `save`: the only thing that ever touches the
    // network is the PUT inside it. Asserting on `fetchSpy`, not just on
    // `save` itself, is what proves the write path never started at all.
    const save = vi.fn(async () => {
      await fetch("/api/overrides", { method: "PUT" });
    });
    const outcome = guardedSave(true, save);
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) expect(outcome.reason).toMatch(/render is running/i);
    expect(save).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("saves normally once no render is running", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const save = vi.fn(async () => {
      await fetch("/api/overrides", { method: "PUT" });
    });
    const outcome = guardedSave(false, save);
    expect(outcome.blocked).toBe(false);
    if (!outcome.blocked) await outcome.result;
    expect(save).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/overrides", { method: "PUT" });
  });
});
