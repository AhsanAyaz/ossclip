import { describe, expect, it } from "vitest";
import {
  ADDED_ID_PREFIX,
  ADDED_OFFERED,
  addedSceneToScene,
  graphicOverlap,
  isAddedKey,
  nextAddedId,
  previewAddedScenes,
  sceneKeyRoot,
  withAddedScenes,
  wordSrcEnd,
  type AddedScene,
} from "../src/added-scenes";
import { SCENE_GAP_SEC } from "../src/assemble";
import { OverrideDocSchema, emptyOverrideDoc } from "../src/overrides";
import { SCENE_REGISTRY } from "../src/scene-registry";
import { ScriptComponentIdSchema, type SceneCue } from "../src/scene-schema";
import { TimeMap } from "../src/timemap";
import type { Segment, Transcript } from "../src/schema";

/** 20 words, 0.5 s apart, 0.4 s long: word i is [i*0.5, i*0.5+0.4] in source. */
const transcript: Transcript = {
  language: "en",
  words: Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 })),
};
const words = transcript.words.map((w) => ({ srcStart: w.start }));
const identity = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" } satisfies Segment]);

const entry = (over: Partial<AddedScene> = {}): AddedScene => ({
  id: "added-1",
  component: "TitleCard",
  props: { title: "HELLO" },
  srcStart: 1.0,
  srcEnd: 2.4,
  ...over,
});

const cue = (id: string, startSec: number, endSec: number, extra: Partial<SceneCue> = {}): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "L", value: "V" },
  startSec,
  endSec,
  ...extra,
});

describe("AddedSceneSchema in the override doc (editor-added-graphics §1)", () => {
  it("parses a stale entry: a removed component and an inverted span never fail the doc (AG3)", () => {
    const doc = OverrideDocSchema.parse({
      addedScenes: [{ id: "added-1", component: "Gone", props: { x: 1 }, srcStart: 5, srcEnd: 2 }],
    });
    expect(doc.addedScenes).toEqual([
      { id: "added-1", component: "Gone", props: { x: 1 }, srcStart: 5, srcEnd: 2 },
    ]);
  });

  it("leaves the key absent on a doc that never had it", () => {
    expect(OverrideDocSchema.parse({}).addedScenes).toBeUndefined();
    expect("addedScenes" in OverrideDocSchema.parse({})).toBe(false);
  });
});

describe("withAddedScenes", () => {
  it("removes the key on an empty list, so an untouched project's file does not change", () => {
    const withOne = withAddedScenes(emptyOverrideDoc(), [entry()]);
    expect(withOne.addedScenes).toEqual([entry()]);
    const cleared = withAddedScenes(withOne, []);
    expect("addedScenes" in cleared).toBe(false);
    // An already-absent key stays absent.
    expect("addedScenes" in withAddedScenes(emptyOverrideDoc(), [])).toBe(false);
  });
});

describe("sceneKeyRoot / isAddedKey (§3)", () => {
  it("strips a parked suffix, then a split suffix", () => {
    expect(sceneKeyRoot("added-3@12.5#orphaned")).toBe("added-3");
    expect(sceneKeyRoot("added-3#orphaned")).toBe("added-3");
    expect(sceneKeyRoot("added-3@s1")).toBe("added-3");
    expect(sceneKeyRoot("scene-2")).toBe("scene-2");
  });

  it("is true only when the ROOT carries the prefix", () => {
    expect(ADDED_ID_PREFIX).toBe("added-");
    expect(isAddedKey("scene-2")).toBe(false);
    expect(isAddedKey("added-3@12.5#orphaned")).toBe(true);
    expect(isAddedKey("scene-2@added-1")).toBe(false);
  });
});

describe("nextAddedId (§1)", () => {
  it("goes one past the highest number among the taken roots", () => {
    expect(nextAddedId(["added-2", "added-10@4", "scene-1"])).toBe("added-11");
    expect(nextAddedId(new Set(["added-7#orphaned"]))).toBe("added-8");
  });

  it("starts at 1, and ignores roots that are not added-<n>", () => {
    expect(nextAddedId([])).toBe("added-1");
    expect(nextAddedId(["added-x", "added-", "scene-9"])).toBe("added-1");
  });
});

describe("wordSrcEnd", () => {
  it("adds the word's spoken length to its source start", () => {
    expect(wordSrcEnd({ srcStart: 10, start: 2, end: 2.25 })).toBeCloseTo(10.25, 9);
  });
});

describe("ADDED_OFFERED (§5)", () => {
  it("is the eleven offered types, every one a script component", () => {
    expect([...ADDED_OFFERED]).toEqual([
      "TitleCard",
      "StatCard",
      "RuleCard",
      "StrikethroughReveal",
      "BulletList",
      "FlowDiagram",
      "ChatMock",
      "CardRow",
      "CtaCard",
      "BugCard",
      "PhoneDemo",
    ]);
    for (const id of ADDED_OFFERED) expect(ScriptComponentIdSchema.safeParse(id).success).toBe(true);
  });
});

describe("addedSceneToScene (§2)", () => {
  const skipped = (r: ReturnType<typeof addedSceneToScene>): string => {
    if (!("skipped" in r)) throw new Error("expected a skip");
    return r.skipped;
  };

  it("skips an unknown component", () => {
    expect(skipped(addedSceneToScene(entry({ component: "Gone" }), words))).toMatch(/Gone/);
  });

  it("skips ScreenshotFrame and ClipScene, which the add gesture never makes", () => {
    expect(skipped(addedSceneToScene(entry({ component: "ScreenshotFrame", props: {} }), words))).toMatch(
      /ScreenshotFrame/,
    );
    expect(skipped(addedSceneToScene(entry({ component: "ClipScene", props: {} }), words))).toMatch(/ClipScene/);
  });

  it("skips invalid props with the first zod issue's message as the reason", () => {
    const props = { title: "" };
    const parsed = SCENE_REGISTRY.TitleCard.propsSchema.safeParse(props);
    expect(parsed.success).toBe(false);
    const first = parsed.success ? "" : parsed.error.issues[0]!.message;
    expect(skipped(addedSceneToScene(entry({ props }), words))).toBe(first);
  });

  it("skips a span that does not end after it starts", () => {
    expect(skipped(addedSceneToScene(entry({ srcStart: 2, srcEnd: 2 }), words))).toBeTruthy();
    expect(skipped(addedSceneToScene(entry({ srcStart: 3, srcEnd: 2 }), words))).toBeTruthy();
  });

  it("skips a span with no word in it", () => {
    // Between w3 (1.5) and w4 (2.0).
    expect(skipped(addedSceneToScene(entry({ srcStart: 1.6, srcEnd: 1.9 }), words))).toMatch(/transcript/);
  });

  it("anchors on the first and last word whose source start is in [srcStart, srcEnd)", () => {
    // 1.0 → w2; srcEnd 2.5 is w5's start, so w5 is OUT (half-open) and w4 is last.
    const r = addedSceneToScene(entry({ srcStart: 1.0, srcEnd: 2.5 }), words);
    if (!("scene" in r)) throw new Error(r.skipped);
    expect(r.scene).toEqual({
      id: "added-1",
      anchor: { startWord: 2, endWord: 4 },
      layout: SCENE_REGISTRY.TitleCard.defaultLayout,
      component: "TitleCard",
      props: { title: "HELLO" },
      overrides: {},
      rationale: "added in the editor",
    });
  });

  it("converts a script-only card", () => {
    const r = addedSceneToScene(
      entry({ component: "BugCard", props: { number: 2, headline: "It broke" } }),
      words,
    );
    if (!("scene" in r)) throw new Error(r.skipped);
    expect(r.scene.layout).toBe(SCENE_REGISTRY.BugCard.defaultLayout);
  });
});

describe("graphicOverlap (§5)", () => {
  it("ignores plain takes", () => {
    expect(graphicOverlap([cue("take-0", 0, 10, { kind: "plain" })], 2, 4)).toBeNull();
  });

  it("counts a cue inside the gap padding, and not one past it", () => {
    const near = cue("scene-1", 0, 2 - SCENE_GAP_SEC / 2);
    expect(graphicOverlap([near], 2, 4)?.id).toBe("scene-1");
    const far = cue("scene-1", 0, 2 - 2 * SCENE_GAP_SEC);
    expect(graphicOverlap([far], 2, 4)).toBeNull();
    // Same on the far side.
    expect(graphicOverlap([cue("scene-2", 4 + SCENE_GAP_SEC / 2, 6)], 2, 4)?.id).toBe("scene-2");
    expect(graphicOverlap([cue("scene-2", 4 + 2 * SCENE_GAP_SEC, 6)], 2, 4)).toBeNull();
  });

  it("returns a plain overlap", () => {
    expect(graphicOverlap([cue("scene-0", 3, 5)], 2, 4)?.id).toBe("scene-0");
  });
});

describe("previewAddedScenes (§4)", () => {
  const run = (baseCues: SceneCue[], added: AddedScene[], issueIds: string[] = []) =>
    previewAddedScenes({ baseCues, added, issueIds: new Set(issueIds), transcript, map: identity });

  it("drops a base added- cue whose entry is gone (rule 1)", () => {
    const { cues } = run([cue("added-4", 1, 3), cue("scene-0", 5, 7)], []);
    expect(cues.map((c) => c.id)).toEqual(["scene-0"]);
  });

  it("keeps a base added- cue that has an entry, without a duplicate", () => {
    const base = cue("added-2", 1, 3, { component: "TitleCard", props: { title: "BAKED" } });
    const { cues, skipped } = run([base], [entry({ id: "added-2" })]);
    expect(cues).toEqual([base]);
    expect(skipped).toEqual([]);
  });

  it("adds an entry that has no base cue, timed by a one-scene assembly (rule 2)", () => {
    const { cues } = run([cue("scene-0", 6, 8)], [entry({ id: "added-1", srcStart: 1.0, srcEnd: 2.4 })]);
    expect(cues.map((c) => c.id)).toEqual(["added-1", "scene-0"]);
    const added = cues[0]!;
    expect(added.component).toBe("TitleCard");
    expect(added.anchor).toEqual({ startWord: 2, endWord: 4 });
    expect(added.startSec).toBeCloseTo(1.0, 9);
    // The floor (3 s on a 10 s video) applies, as in a full run.
    expect(added.endSec - added.startSec).toBeGreaterThanOrEqual(1.4);
  });

  it("does not preview an entry produce reported as an issue", () => {
    const { cues, skipped } = run([], [entry({ id: "added-3" })], ["added-3"]);
    expect(cues).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("reports a new entry whose props fail", () => {
    const { cues, skipped } = run([], [entry({ id: "added-5", props: { title: "" } })]);
    expect(cues).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe("added-5");
    expect(skipped[0]!.reason).toBeTruthy();
  });

  it("reports a new entry that assembly drops", () => {
    const cutAll = new TimeMap([
      { srcIn: 0, srcOut: 5, kind: "remove", reason: "user" },
      { srcIn: 5, srcOut: 10, kind: "keep" },
    ] satisfies Segment[]);
    const r = previewAddedScenes({
      baseCues: [],
      added: [entry({ id: "added-6", srcStart: 1.0, srcEnd: 2.4 })],
      issueIds: new Set(),
      transcript,
      map: cutAll,
    });
    expect(r.cues).toEqual([]);
    expect(r.skipped.map((s) => s.id)).toEqual(["added-6"]);
  });
});
