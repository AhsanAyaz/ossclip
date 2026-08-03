import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeWorkdir } from "../src/interactive/workdir-probe";

const scratch = (): string => mkdtempSync(join(tmpdir(), "ossclip-probe-"));

const makeRun = (root: string, name: string): string => {
  const dir = join(root, ".ossclip", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "render-props.json"), "{}");
  return dir;
};

describe("probeWorkdir", () => {
  it("reports a directory that is itself a workdir", async () => {
    const root = scratch();
    writeFileSync(join(root, "render-props.json"), "{}");
    const { dir, probe } = await probeWorkdir(root);
    expect(dir).toBe(root);
    expect(probe.isWorkdir).toBe(true);
  });

  it("finds runs nested under .ossclip", async () => {
    const root = scratch();
    const a = makeRun(root, "take-aaa");
    const b = makeRun(root, "take-bbb");
    const { probe } = await probeWorkdir(root);
    expect(probe.isWorkdir).toBe(false);
    expect(probe.candidates.map((c) => c.path).sort()).toEqual([a, b].sort());
  });

  // Rung 4: pointing at the video itself is a reasonable guess, and the runs
  // live beside it.
  it("treats a file target as its parent directory", async () => {
    const root = scratch();
    const run = makeRun(root, "take-aaa");
    const video = join(root, "take.mp4");
    writeFileSync(video, "not really a video");
    const { dir, probe } = await probeWorkdir(video);
    expect(dir).toBe(root);
    expect(probe.candidates.map((c) => c.path)).toEqual([run]);
  });

  it("ignores .ossclip children that never finished producing", async () => {
    const root = scratch();
    const good = makeRun(root, "take-good");
    mkdirSync(join(root, ".ossclip", "take-halfdone"), { recursive: true });
    const { probe } = await probeWorkdir(root);
    expect(probe.candidates.map((c) => c.path)).toEqual([good]);
  });

  it("reports an empty probe for a path that does not exist", async () => {
    const { probe } = await probeWorkdir(join(scratch(), "nope"));
    expect(probe).toEqual({ isWorkdir: false, candidates: [] });
  });
});
