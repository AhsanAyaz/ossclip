import { describe, expect, it } from "vitest";
import { OverrideDocSchema, type SceneCue } from "@ossclip/core/browser";
import { ghostCues } from "../src/ghosts";
import { editReducer, initialEditState } from "../src/useEdits";

/** Same minimal graphic cue shape `overrides.test.ts` uses. */
const cue = (id: string): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "CODE CHURN", value: "861%", inverted: false },
  startSec: 0,
  endSec: 5,
});

// Mirrors the field case (`overrides.test.ts`'s "the produce.ts / editor
// pipeline order" describe block): scene-5 before, scene-6 split at 36.4.
const before = (): SceneCue => ({ ...cue("scene-5"), startSec: 0, endSec: 30 });
const splitScene = (): SceneCue => ({ ...cue("scene-6"), startSec: 30, endSec: 40 });

describe("ghostCues (PLAN 2026-08-04 fix wave, final review finding 2)", () => {
  it("lists a hidden split-off HALF, at its own post-split window", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-6@36400": { hidden: true } },
      splits: [36.4],
    });
    const ghosts = ghostCues([before(), splitScene()], doc);
    expect(ghosts.map((c) => c.id)).toEqual(["scene-6@36400"]);
    const half = ghosts[0]!;
    // The half's OWN window, not the whole pre-split scene's [30, 40] —
    // the exact thing filtering the pre-split cues could never produce.
    expect(half.startSec).toBe(36.4);
    expect(half.endSec).toBe(40);
    expect(half.component).toBe("StatCard");
  });

  it("lists a hidden split ROOT at its own post-split window, unaffected by its sibling half", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-6": { hidden: true } },
      splits: [36.4],
    });
    const ghosts = ghostCues([before(), splitScene()], doc);
    expect(ghosts.map((c) => c.id)).toEqual(["scene-6"]);
    const root = ghosts[0]!;
    expect(root.startSec).toBe(30);
    expect(root.endSec).toBe(36.4);
  });

  it("still lists an UNSPLIT hidden scene at its whole window, as before", () => {
    const doc = OverrideDocSchema.parse({ scenes: { "scene-6": { hidden: true } } });
    const ghosts = ghostCues([before(), splitScene()], doc);
    expect(ghosts.map((c) => c.id)).toEqual(["scene-6"]);
    expect(ghosts[0]!.startSec).toBe(30);
    expect(ghosts[0]!.endSec).toBe(40);
  });

  it("Restore acts on exactly ONE hidden half, leaving its sibling hidden and ghosted", () => {
    // Both halves of the same split independently deleted — restoreScene is
    // keyed by exact scene id (useEdits.ts), so restoring one must never
    // touch the other's `hidden` entry.
    let state = initialEditState();
    state = editReducer(state, {
      type: "load",
      doc: OverrideDocSchema.parse({
        scenes: { "scene-6": { hidden: true }, "scene-6@36400": { hidden: true } },
        splits: [36.4],
      }),
    });
    let ghosts = ghostCues([before(), splitScene()], state.doc);
    expect(ghosts.map((c) => c.id).sort()).toEqual(["scene-6", "scene-6@36400"]);

    state = editReducer(state, { type: "restoreScene", sceneId: "scene-6@36400" });
    ghosts = ghostCues([before(), splitScene()], state.doc);
    // Only the restored half is gone from the ghost list...
    expect(ghosts.map((c) => c.id)).toEqual(["scene-6"]);
    // ...and the OTHER half's own hidden entry survived untouched.
    expect(state.doc.scenes["scene-6@36400"]?.hidden).toBeUndefined();
    expect(state.doc.scenes["scene-6"]?.hidden).toBe(true);
  });
});
