import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTimeLimit } from "../src/drawn/render";

/**
 * withinTimeLimit's timing, on fake timers. The drawn-render test (c) can
 * only bound it loosely, because its wall clock also counts a real browser's
 * start and teardown, which stretch under load; here the limit is exact.
 */
const WHAT = "the still at frame 3";
const MS = 15_000;
const LIMIT_ERROR = /the still at frame 3 did not finish within 15000 ms/;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Tracks whether a promise has settled, without awaiting it. */
function track<T>(p: Promise<T>): { settled: () => boolean } {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  return { settled: () => done };
}

describe("withinTimeLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a run that never settles at exactly ms, not before", async () => {
    const never = new Promise<string>(() => {});
    const result = withinTimeLimit(never, MS, WHAT, async () => {});
    const assertion = expect(result).rejects.toThrow(LIMIT_ERROR);
    const state = track(result);
    await vi.advanceTimersByTimeAsync(MS - 1);
    expect(state.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("calls expire exactly once, and only when the limit passes", async () => {
    const expire = vi.fn(async () => {});
    const result = withinTimeLimit(new Promise<string>(() => {}), MS, WHAT, expire);
    const assertion = expect(result).rejects.toThrow(LIMIT_ERROR);
    await vi.advanceTimersByTimeAsync(MS - 1);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(expire).toHaveBeenCalledTimes(1);
    // Nothing re-arms it: more time passing changes nothing.
    await vi.advanceTimersByTimeAsync(MS * 2);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("keeps the time-limit error when run then rejects with the closed browser's", async () => {
    // As in renderDrawnStills: expire closes the browser, and the step's
    // render rejects with "Target closed", which would hide why it closed.
    const run = deferred<string>();
    const expire = async (): Promise<void> => {
      run.reject(new Error("Target closed"));
    };
    const result = withinTimeLimit(run.promise, MS, WHAT, expire);
    const assertion = expect(result).rejects.toThrow(LIMIT_ERROR);
    await vi.advanceTimersByTimeAsync(MS);
    await assertion;
    await expect(run.promise).rejects.toThrow("Target closed");
  });

  it("resolves a run that finishes in time, without expire and without a pending timer", async () => {
    const run = deferred<string>();
    const expire = vi.fn(async () => {});
    const result = withinTimeLimit(run.promise, MS, WHAT, expire);
    await vi.advanceTimersByTimeAsync(MS - 1);
    run.resolve("still-1.png");
    await expect(result).resolves.toBe("still-1.png");
    expect(expire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
