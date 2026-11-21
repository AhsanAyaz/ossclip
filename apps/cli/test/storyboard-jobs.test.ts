import { describe, expect, it } from "vitest";
import { JOB_LINES_MAX, JobBusyError, createJobRunner } from "../src/storyboard/jobs";

/**
 * The editor's storyboard job runner (plan B2a Task 4; §169), pure: no
 * server, no draw. `each` is the per-shot work the endpoints pass in.
 */

/** A promise and the function that settles it, to hold a shot mid-work. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe("createJobRunner", () => {
  it("starts empty", () => {
    expect(createJobRunner(() => 0).state()).toEqual({ job: null, last: null });
  });

  it("a second start while one runs throws JobBusyError, synchronously", async () => {
    const runner = createJobRunner(() => 7);
    const g = gate();
    const first = runner.start("draw", ["s1"], async () => {
      await g.wait;
      return { ok: true };
    });
    expect(() => runner.start("preview", ["s2"], async () => ({ ok: true }))).toThrow(JobBusyError);
    expect(runner.state().job).toMatchObject({ kind: "draw", shots: ["s1"], current: "s1", startedAt: 7, stopping: false });
    g.open();
    await first;
  });

  it("one shot failing and one throwing are recorded and the others still run (Review Focus 3)", async () => {
    const runner = createJobRunner(() => 0);
    const ran: string[] = [];
    await runner.start("draw", ["s1", "s2", "s3", "s4"], async (id) => {
      ran.push(id);
      if (id === "s2") return { ok: false, error: "failed after 3 attempts" };
      if (id === "s3") throw new Error("bundle exploded");
      return { ok: true };
    });
    expect(ran).toEqual(["s1", "s2", "s3", "s4"]);
    const { job, last } = runner.state();
    expect(job).toBeNull();
    expect(last!.done).toEqual([
      { id: "s1", ok: true },
      { id: "s2", ok: false, error: "failed after 3 attempts" },
      { id: "s3", ok: false, error: "bundle exploded" },
      { id: "s4", ok: true },
    ]);
    expect(last!.current).toBeNull();
  });

  it("stop() during shot 1: shot 2 never starts, and stopping is true until the job ends", async () => {
    const runner = createJobRunner(() => 0);
    const g = gate();
    const ran: string[] = [];
    let seen = false;
    const job = runner.start("draw", ["s1", "s2"], async (id, ctx) => {
      ran.push(id);
      await g.wait;
      seen = ctx.shouldStop();
      return { ok: false, error: "stopped" };
    });
    expect(runner.stop()).toBe(true);
    expect(runner.state().job!.stopping).toBe(true);
    g.open();
    await job;
    expect(seen).toBe(true);
    expect(ran).toEqual(["s1"]);
    expect(runner.state()).toMatchObject({ job: null, last: { stopping: true, done: [{ id: "s1", ok: false }] } });
    // Nothing runs now.
    expect(runner.stop()).toBe(false);
  });

  it("counts the calls and keeps the progress lines, never more than the cap", async () => {
    const runner = createJobRunner(() => 0);
    await runner.start("draw", ["s1"], async (_id, ctx) => {
      for (let i = 0; i < JOB_LINES_MAX + 50; i++) ctx.log(`line ${i}`);
      ctx.addCalls(2);
      ctx.addCalls(1);
      return { ok: true };
    });
    const last = runner.state().last!;
    expect(last.calls).toBe(3);
    expect(last.lines.length).toBeLessThanOrEqual(JOB_LINES_MAX);
    expect(last.lines[last.lines.length - 1]).toBe(`line ${JOB_LINES_MAX + 49}`);
  });

  it("a new job replaces last when it ends, and the state handed out is a copy", async () => {
    const runner = createJobRunner(() => 0);
    await runner.start("draw", ["s1"], async () => ({ ok: true }));
    const snapshot = runner.state();
    snapshot.last!.done.push({ id: "x", ok: true });
    expect(runner.state().last!.done).toHaveLength(1);
    await runner.start("approve", ["s2"], async () => ({ ok: true }));
    expect(runner.state().last).toMatchObject({ kind: "approve", shots: ["s2"] });
  });
});

describe("createJobRunner finish", () => {
  it("runs after the last shot and before the job reads as ended; a throw from it is a line, not a rejection", async () => {
    const runner = createJobRunner(() => 0);
    let seenDuringFinish: unknown = "unset";
    await runner.start(
      "draw",
      ["s1"],
      async () => ({ ok: true }),
      async () => {
        seenDuringFinish = runner.state().job?.kind;
        throw new Error("usage.json is read-only");
      },
    );
    expect(seenDuringFinish).toBe("draw");
    expect(runner.state().job).toBeNull();
    expect(runner.state().last!.lines).toContain("✗ usage.json is read-only");
  });
});

describe("createJobRunner plan (§169)", () => {
  it("a plan job is one unit, and what setPlan stores lands on last.plan, copied", async () => {
    const runner = createJobRunner(() => 0);
    const ran: string[] = [];
    const g = gate();
    const job = runner.start("plan", ["plan"], async (id, ctx) => {
      ran.push(id);
      await g.wait;
      ctx.setPlan({ changes: [{ index: 1, kind: "dropped", reason: "over the coverage limit" }], usage: "▸ llm: 1 calls" });
      return { ok: true };
    });
    expect(runner.state().job).toMatchObject({ kind: "plan", shots: ["plan"], current: "plan" });
    expect(runner.state().job!.plan).toBeUndefined();
    g.open();
    await job;
    expect(ran).toEqual(["plan"]);
    const { last } = runner.state();
    expect(last!.done).toEqual([{ id: "plan", ok: true }]);
    expect(last!.plan).toEqual({ changes: [{ index: 1, kind: "dropped", reason: "over the coverage limit" }], usage: "▸ llm: 1 calls" });
    // A copy: a caller cannot change what the next look serves.
    last!.plan!.changes.push({ index: 2, kind: "dropped", reason: "x" });
    expect(runner.state().last!.plan!.changes).toHaveLength(1);
  });

  it("a plan that throws records ok false with its message and no plan", async () => {
    const runner = createJobRunner(() => 0);
    await runner.start("plan", ["plan"], async () => {
      throw new Error("quota exceeded");
    });
    const { last } = runner.state();
    expect(last!.done).toEqual([{ id: "plan", ok: false, error: "quota exceeded" }]);
    expect(last!.plan).toBeUndefined();
  });
});
