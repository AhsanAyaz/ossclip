import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShotHistory } from "@ossclip/core";
import { SHOT_HISTORY_BASENAME, saveShot, shotDir, versionPaths } from "../src/draw/shot-store";
import { shotDetail } from "../src/storyboard/shot-detail";

/**
 * What the editor's shot view is served of one shot (plan B2a Task 4;
 * §169), on a real temp workdir: which still and preview files exist is
 * most of what it answers.
 */
let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ossclip-shot-detail-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const history = (over: Partial<ShotHistory> = {}): ShotHistory => ({
  id: "s1",
  idea: "a cat walks in",
  spokenLine: "the cat",
  durationSec: 4,
  versions: [
    { n: 1, result: "ok", kitVersion: 1, said: "a fish", idea: "a fish swims" },
    { n: 2, result: { failed: "line 2 [name] fetch is not allowed" }, kitVersion: 1 },
    { n: 3, result: "ok", kitVersion: 1, said: "a cat", idea: "a cat walks in" },
  ],
  draft: 3,
  nextVersion: 4,
  notes: [{ onVersion: 1, text: "bigger fish" }],
  runs: [],
  ...over,
});

const still = (n: number, k: number): void => {
  const dir = versionPaths(work, "s1", n).stillsDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `still-${k}.png`), "png");
};

describe("shotDetail", () => {
  it("an unknown shot is null", () => {
    expect(shotDetail(work, "s1")).toBeNull();
  });

  it("lists only the still files that exist, as /media URLs in order", () => {
    saveShot(work, history());
    still(3, 2);
    still(3, 1);
    still(1, 1);
    const d = shotDetail(work, "s1")!;
    expect(d.versions.find((v) => v.n === 3)!.stills).toEqual([
      "/media/storyboard/s1/v3/still-1.png",
      "/media/storyboard/s1/v3/still-2.png",
    ]);
    expect(d.versions.find((v) => v.n === 1)!.stills).toEqual(["/media/storyboard/s1/v1/still-1.png"]);
    expect(d).toMatchObject({ draft: 3, notes: [{ onVersion: 1, text: "bigger fish" }] });
  });

  it("a failed version carries its error and no stills", () => {
    saveShot(work, history());
    still(2, 1);
    const v2 = shotDetail(work, "s1")!.versions.find((v) => v.n === 2)!;
    expect(v2).toMatchObject({ n: 2, ok: false, error: "line 2 [name] fetch is not allowed", kitVersion: 1, stills: [], preview: null });
  });

  it("preview is null until the file exists", () => {
    saveShot(work, history());
    expect(shotDetail(work, "s1")!.versions.find((v) => v.n === 3)!.preview).toBeNull();
    still(3, 1);
    writeFileSync(versionPaths(work, "s1", 3).preview, "webm");
    expect(shotDetail(work, "s1")!.versions.find((v) => v.n === 3)!.preview).toBe("/media/storyboard/s1/v3/preview.webm");
  });

  it("a version without a result does not appear, and nothing on disk is touched (Review Focus 2)", () => {
    const h = history({ versions: [...history().versions, { n: 4, kitVersion: 1 }], nextVersion: 5 });
    saveShot(work, h);
    writeFileSync(versionPaths(work, "s1", 4).code, "partial");
    const before = readFileSync(join(shotDir(work, "s1"), SHOT_HISTORY_BASENAME), "utf8");
    expect(shotDetail(work, "s1")!.versions.map((v) => v.n)).toEqual([1, 2, 3]);
    expect(readFileSync(join(shotDir(work, "s1"), SHOT_HISTORY_BASENAME), "utf8")).toBe(before);
    expect(readFileSync(versionPaths(work, "s1", 4).code, "utf8")).toBe("partial");
  });

  it("drawnIdea is the draft version's idea, null with no draft (§169)", () => {
    saveShot(work, history());
    expect(shotDetail(work, "s1")!.drawnIdea).toBe("a cat walks in");
    saveShot(work, history({ draft: 1 }));
    expect(shotDetail(work, "s1")!.drawnIdea).toBe("a fish swims");
    // A version from before the field: the history's idea.
    saveShot(work, history({ versions: [{ n: 1, result: "ok", kitVersion: 1 }], draft: 1, nextVersion: 2 }));
    expect(shotDetail(work, "s1")!.drawnIdea).toBe("a cat walks in");
    saveShot(work, history({ versions: [{ n: 1, result: { failed: "x" }, kitVersion: 1 }], draft: null, nextVersion: 2 }));
    expect(shotDetail(work, "s1")!.drawnIdea).toBeNull();
  });

  it("the said line is passed through", () => {
    saveShot(work, history());
    expect(shotDetail(work, "s1")!.versions.find((v) => v.n === 3)!.said).toBe("a cat");
  });
});
