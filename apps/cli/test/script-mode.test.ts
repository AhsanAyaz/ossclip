import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  SCRIPT_PLAN_PROMPT_VERSION,
  TimeMap,
  cutWordIndices,
  parseScript,
  type AlignedCue,
  type Moment,
  type Scene,
  type Segment,
  type SkippedCue,
} from "@ossclip/core";
import {
  STORED_SCRIPT_BASENAME,
  ScriptPlanCacheSchema,
  cueOutcomes,
  formatCueReport,
  isFootageCueIssue,
  isProjectClipSrc,
  keptWordTimes,
  keptWordsKey,
  loadScriptText,
  mergeClipRecords,
  planScriptClips,
  replanScriptArgs,
  scriptCueProblems,
  scriptPlanCacheKey,
  scriptPlanCacheKeyCandidates,
  scriptPlanCut,
  scriptPlanCutlist,
  scriptSourcePath,
  storedScriptFrom,
  type CueOutcome,
} from "../src/script-mode";

describe("loadScriptText", () => {
  it("returns the file's text", () => {
    expect(loadScriptText("/s/a.md", () => "🎬 A")).toBe("🎬 A");
  });

  it("an unreadable file fails naming it", () => {
    expect(() =>
      loadScriptText("/s/missing.md", () => {
        throw new Error("ENOENT");
      }),
    ).toThrow("script file not found: /s/missing.md");
  });
});

describe("scriptCueProblems (before any transcription)", () => {
  it("a clean script has none", () => {
    const cues = parseScript("🎬 [StatCard] x\n🗣️ a\n🎬 clip: clips/a.mov\n🗣️ b");
    expect(scriptCueProblems(cues, "/s/script.md")).toEqual([]);
  });

  it("an unknown [Name] names its line and the valid names", () => {
    const [p] = scriptCueProblems(parseScript("🎬 A\n🗣️ a\n🎬 [Nope] x\n🗣️ b"), "/s/script.md");
    expect(p).toMatch(/^script line 3: unknown component \[Nope\]/);
    expect(p).toContain("TitleCard");
    // ClipScene is no planner's name, so it is not offered as a fix.
    expect(p).not.toContain("ClipScene");
  });

  it("a [CardRow] hint is valid; [CardRows] lists CardRow among the valid names (§161)", () => {
    expect(scriptCueProblems(parseScript("🎬 [CardRow] three steps\n🗣️ a"), "/s/script.md")).toEqual([]);
    const [p] = scriptCueProblems(parseScript("🎬 [CardRows] three steps\n🗣️ a"), "/s/script.md");
    expect(p).toMatch(/^script line 1: unknown component \[CardRows\]/);
    expect(p).toMatch(/valid names: .*CardRow/);
    expect(p).not.toContain("ClipScene");
  });

  it("a clip path that leaves the script's folder names its line and the path", () => {
    const problems = scriptCueProblems(
      parseScript("🎬 clip: ../x.mov\n🗣️ a\n🎬 clip: /etc/x.mov\n🗣️ b"),
      "/s/script.md",
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^script line 1: .*\.\.\/x\.mov/);
    expect(problems[1]).toMatch(/^script line 3: .*\/etc\/x\.mov/);
  });

  it("more than 40 cues states the count", () => {
    const text = Array.from({ length: 41 }, (_, i) => `🎬 cue ${i}\n🗣️ line ${i}`).join("\n");
    expect(scriptCueProblems(parseScript(text), "/s/script.md")).toEqual([
      expect.stringContaining("41 cues"),
    ]);
  });

  it("a file with no cues at all is refused (the wrong file, almost always)", () => {
    expect(scriptCueProblems(parseScript("# Notes\nprose"), "/s/n.md")).toEqual([
      expect.stringContaining("no 🎬 cues"),
    ]);
  });

  it("lists every problem, not the first", () => {
    const cues = parseScript("🎬 [Nope] x\n🗣️ a\n🎬 clip: ../y.mov\n🗣️ b");
    expect(scriptCueProblems(cues, "/s/script.md")).toHaveLength(2);
  });
});

describe("storedScriptFrom", () => {
  it("reads the record, parsed", () => {
    expect(storedScriptFrom(JSON.stringify({ script: { text: "🎬 A", sourcePath: "/s.md" } }))).toEqual({
      text: "🎬 A",
      sourcePath: "/s.md",
    });
  });

  it("no record, a malformed one, or unreadable JSON all mean none", () => {
    expect(storedScriptFrom(JSON.stringify({ version: 1 }))).toBeUndefined();
    expect(storedScriptFrom(JSON.stringify({ script: { sourcePath: "/s.md" } }))).toBeUndefined();
    expect(storedScriptFrom("{not json")).toBeUndefined();
  });
});

describe("scriptSourcePath", () => {
  it("is the given file for an ordinary run", () => {
    expect(scriptSourcePath("/videos/egm/script.md", "/w", undefined)).toBe("/videos/egm/script.md");
  });

  it("is the recorded source when Re-plan points at the workdir copy", () => {
    // Clips resolve beside the ORIGINAL script, not inside the workdir.
    const copy = `/w/${STORED_SCRIPT_BASENAME}`;
    expect(scriptSourcePath(copy, "/w", { text: "x", sourcePath: "/videos/egm/script.md" })).toBe(
      "/videos/egm/script.md",
    );
    // No record of a source: the copy is all there is.
    expect(scriptSourcePath(copy, "/w", { text: "x" })).toBe(copy);
  });
});

describe("planScriptClips", () => {
  const cues = parseScript("🎬 clip: clips/a.mov\n🗣️ a\n🎬 clip: clips/b.mov\n🗣️ b");

  it("resolves each clip cue beside the source script", () => {
    const { clips, problems } = planScriptClips(cues, "/s/script.md", "/w", [], () => true);
    expect(problems).toEqual([]);
    expect(clips.get(cues[0]!.id)).toEqual({ path: "clips/a.mov", abs: "/s/clips/a.mov" });
  });

  it("a missing source names its line and the file", () => {
    const { problems } = planScriptClips(cues, "/s/script.md", "/w", [], (p) => p !== "/s/clips/b.mov");
    expect(problems).toEqual(["script line 3: clip file not found: /s/clips/b.mov"]);
  });

  it("a missing source whose WebM is already in the project is reused", () => {
    const stored = [{ path: "clips/b.mov", src: "clips/0123456789ab.webm", durationSec: 2.5 }];
    const present = new Set(["/s/clips/a.mov", "/w/clips/0123456789ab.webm"]);
    const { clips, problems } = planScriptClips(cues, "/s/script.md", "/w", stored, (p) => present.has(p));
    expect(problems).toEqual([]);
    expect(clips.get(cues[1]!.id)!.reuse).toEqual({ src: "clips/0123456789ab.webm", durationSec: 2.5 });
  });

  it("a recorded WebM that is gone too is still a missing clip", () => {
    const stored = [{ path: "clips/b.mov", src: "clips/0123456789ab.webm", durationSec: 2.5 }];
    const { problems } = planScriptClips(cues, "/s/script.md", "/w", stored, (p) => p === "/s/clips/a.mov");
    expect(problems).toEqual(["script line 3: clip file not found: /s/clips/b.mov"]);
  });
});

describe("mergeClipRecords", () => {
  const a = { path: "clips/a.mov", src: "clips/aaaaaaaaaaaa.webm", durationSec: 1 };
  const b = { path: "clips/b.mov", src: "clips/bbbbbbbbbbbb.webm", durationSec: 2 };
  const a2 = { ...a, src: "clips/cccccccccccc.webm" };

  it("keeps a record the script still names but this run did not import", () => {
    expect(mergeClipRecords([a, b], [a2], ["clips/a.mov", "clips/b.mov"])).toEqual([a2, b]);
  });

  it("drops records for clips the script no longer names", () => {
    expect(mergeClipRecords([a, b], [a2], ["clips/a.mov"])).toEqual([a2]);
  });
});

describe("isProjectClipSrc", () => {
  it("accepts only the import's own output shape", () => {
    expect(isProjectClipSrc("clips/0123456789ab.webm")).toBe(true);
    expect(isProjectClipSrc("clips/../x.webm")).toBe(false);
    expect(isProjectClipSrc("../clips/0123456789ab.webm")).toBe(false);
    expect(isProjectClipSrc("clips/0123456789ab.mov")).toBe(false);
  });
});

describe("scriptPlanCacheKey", () => {
  const parts = {
    promptVersion: "s1",
    scriptText: "🎬 A\n🗣️ a",
    keptWords: keptWordsKey([{ text: "a" }, { text: "b" }], new Set()),
    clipNames: ["clips/0123456789ab.webm"],
    providerName: "mock",
  };
  const key = scriptPlanCacheKey(parts);

  it("is stable for equal parts", () => {
    expect(scriptPlanCacheKey({ ...parts })).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes with the script text, the kept words, the prompt version and the clips", () => {
    expect(scriptPlanCacheKey({ ...parts, scriptText: "🎬 B\n🗣️ a" })).not.toBe(key);
    expect(scriptPlanCacheKey({ ...parts, keptWords: keptWordsKey([{ text: "a" }], new Set()) })).not.toBe(key);
    expect(scriptPlanCacheKey({ ...parts, promptVersion: "s2" })).not.toBe(key);
    expect(scriptPlanCacheKey({ ...parts, clipNames: ["clips/ba9876543210.webm"] })).not.toBe(key);
  });

  it("changes with what steers the plan, as the beat-sheet key does (§78)", () => {
    expect(scriptPlanCacheKey({ ...parts, providerName: "gemini" })).not.toBe(key);
    expect(scriptPlanCacheKey({ ...parts, forceComponent: "FlowDiagram" })).not.toBe(key);
    expect(scriptPlanCacheKey({ ...parts, llmModel: "m" })).not.toBe(key);
  });

  it("kept words carry their index: the same text kept from a different take is a different key", () => {
    const words = [{ text: "right" }, { text: "right" }];
    expect(keptWordsKey(words, new Set([0]))).not.toBe(keptWordsKey(words, new Set([1])));
  });

  it("the prompt version is \"s3\": a plan cached before the minimum scene length is never reused", () => {
    // "s2" plans were cached with every scene's end word on its line's last
    // word (§161): served now, they would keep the 1.2-2.3 s scenes the
    // minimum exists to remove. "s1" plans were asked without CardRow on the
    // menu (Review Focus 4). Only a new key guarantees either re-plans.
    expect(SCRIPT_PLAN_PROMPT_VERSION).toBe("s3");
    const current = scriptPlanCacheKey({ ...parts, promptVersion: SCRIPT_PLAN_PROMPT_VERSION });
    expect(current).not.toBe(scriptPlanCacheKey({ ...parts, promptVersion: "s2" }));
    expect(current).not.toBe(scriptPlanCacheKey({ ...parts, promptVersion: "s1" }));
  });

  it("reads try the primary, then the fallback provider (§150)", () => {
    const { providerName: _p, ...rest } = parts;
    expect(scriptPlanCacheKeyCandidates(rest, "antigravity", "claude-cli")).toEqual([
      scriptPlanCacheKey({ ...rest, providerName: "antigravity" }),
      scriptPlanCacheKey({ ...rest, providerName: "claude-cli" }),
    ]);
    expect(scriptPlanCacheKeyCandidates(rest, "mock", undefined)).toHaveLength(1);
  });
});

describe("ScriptPlanCacheSchema", () => {
  it("holds more moments than a beat sheet's 24 (a script may carry 40)", () => {
    const moments = Array.from({ length: 30 }, (_, i) => ({
      startWord: i,
      endWord: i,
      purpose: "p",
      onScreenCopy: "c",
      sceneKind: "TitleCard",
    }));
    expect(() => ScriptPlanCacheSchema.parse({ hook: "h", moments, scenes: [], issues: [], failures: 0 })).not.toThrow();
  });

  it("reads back a plan holding a CardRow — with the beat-sheet enum it would re-plan every run", () => {
    const moments = [{ startWord: 0, endWord: 2, purpose: "p", onScreenCopy: "c", sceneKind: "CardRow" }];
    const scenes = [
      {
        id: "scene-0",
        anchor: { startWord: 0, endWord: 2 },
        layout: "full-bleed",
        component: "CardRow",
        props: { cards: [{ text: "A" }, { text: "B" }] },
      },
    ];
    const parsed = ScriptPlanCacheSchema.safeParse({ hook: "h", moments, scenes, issues: [], failures: 0 });
    expect(parsed.success).toBe(true);
  });
});

describe("isFootageCueIssue", () => {
  it("matches the planner's footage-cue issue only", () => {
    expect(isFootageCueIssue({ issue: "footage cue cue-2-abcd1234: no graphic, stays talking head" })).toBe(true);
    expect(isFootageCueIssue({ issue: "script_plan reply left out cue-2-abcd1234" })).toBe(false);
  });
});

describe("cueOutcomes", () => {
  // Seven cues covering every status, in script order.
  const cues = parseScript(
    [
      "🎬 Title: the hook", //        1 placed
      "🗣️ one two three",
      "🎬 screen: demo of the editor", // 3 reported (screen recording)
      "🗣️ four five",
      "🎬 Flash on screen: 4,494 tests", // 5 skipped (no spoken lines)
      "🎬 Screen recording: terminal", // 6 reported (footage cue)
      "🗣️ six seven",
      "🎬 A line that was dropped", //    8 skipped (below floor)
      "🗣️ never said at all",
      "🎬 clip: clips/a.mov", //          10 shortened
      "🗣️ eight nine",
      "🎬 Its words were cut", //         12 skipped (dropped by the assembler)
      "🗣️ ten",
    ].join("\n"),
  );
  const [hook, screen, flash, footage, dropped, clipCue, cutCue] = cues as [
    (typeof cues)[number],
    (typeof cues)[number],
    (typeof cues)[number],
    (typeof cues)[number],
    (typeof cues)[number],
    (typeof cues)[number],
    (typeof cues)[number],
  ];
  const aligned: AlignedCue[] = [
    { cue: hook, startWord: 0, endWord: 2, score: 1 },
    { cue: footage, startWord: 5, endWord: 6, score: 1 },
    { cue: clipCue, startWord: 7, endWord: 8, score: 1 },
    { cue: cutCue, startWord: 9, endWord: 9, score: 1 },
  ];
  const skipped: SkippedCue[] = [
    { cue: screen, reason: "screen" },
    { cue: flash, reason: "no-spoken-lines" },
    { cue: dropped, reason: "below-floor", score: 0.33 },
  ];
  const moment = (startWord: number, endWord: number, sceneKind: Moment["sceneKind"]): Moment => ({
    startWord,
    endWord,
    purpose: "p",
    onScreenCopy: "c",
    sceneKind,
  });
  const scene = (id: string, startWord: number, endWord: number, component: Scene["component"]): Scene => ({
    id,
    anchor: { startWord, endWord },
    layout: "full-bleed",
    component,
    props: {},
    overrides: {},
  });
  const outcomes = cueOutcomes({
    cues,
    aligned,
    skipped,
    moments: [moment(0, 2, "TitleCard"), moment(5, 6, "none"), moment(7, 8, "none"), moment(9, 9, "TitleCard")],
    // Normalization may move a start forward; the match is on endWord.
    scenes: [scene("scene-0", 1, 2, "TitleCard"), scene("scene-2", 7, 8, "ClipScene"), scene("scene-3", 9, 9, "TitleCard")],
    timed: [
      { id: "scene-0", startSec: 0.3 },
      { id: "scene-2", startSec: 4.2 },
    ],
    dropped: [{ id: "scene-3", reason: "anchor words were entirely cut" }],
    shortened: [{ id: "scene-2", fromSec: 20, toSec: 15 }],
  });

  it("one outcome per parsed cue, in script order, with its script line", () => {
    expect(outcomes.map((o) => o.cueId)).toEqual(cues.map((c) => c.id));
    expect(outcomes.map((o) => o.line)).toEqual([1, 3, 5, 6, 8, 10, 12]);
  });

  it("covers every status", () => {
    expect(outcomes.map((o) => o.status)).toEqual([
      "placed",
      "reported",
      "skipped",
      "reported",
      "skipped",
      "shortened",
      "skipped",
    ]);
  });

  it("carries the details each status reports", () => {
    expect(outcomes[0]).toMatchObject({ component: "TitleCard", startSec: 0.3, text: "Title: the hook" });
    expect(outcomes[1]).toMatchObject({ reason: "screen recording" });
    expect(outcomes[2]).toMatchObject({ reason: "no spoken lines" });
    expect(outcomes[3]).toMatchObject({ reason: "footage cue" });
    expect(outcomes[4]).toMatchObject({ reason: expect.stringContaining("0.6"), score: 0.33 });
    expect(outcomes[5]).toMatchObject({ component: "ClipScene", startSec: 4.2, fromSec: 20, toSec: 15 });
    expect(outcomes[6]).toMatchObject({ reason: "dropped: anchor words were entirely cut" });
  });

  it("formats one line per cue with its script line, and a summary that adds up", () => {
    const report = formatCueReport(outcomes);
    const lines = report.split("\n");
    expect(lines[0]).toBe("script cues:");
    expect(lines).toHaveLength(1 + cues.length + 1);
    expect(lines[1]).toMatch(/^ {2}line 1 +placed +TitleCard at 0\.3s — "Title: the hook"$/);
    expect(lines[5]).toContain("(best match 0.33)");
    expect(lines[6]).toContain("20.0s cut to 15.0s");
    expect(lines.at(-1)).toBe("placed 2 of 7 (1 shortened) · skipped 3 · reported 2");
  });

  it("the summary reads placed N of M when nothing was shortened", () => {
    const placed: CueOutcome[] = [
      { cueId: "a", line: 1, text: "a", status: "placed", component: "TitleCard", startSec: 0 },
      { cueId: "b", line: 2, text: "b", status: "skipped", reason: "no spoken lines" },
    ];
    expect(formatCueReport(placed).split("\n").at(-1)).toBe("placed 1 of 2 · skipped 1 · reported 0");
  });
});

describe("cueOutcomes and formatCueReport: a lengthened scene (§161, SCRIPT_MIN_SCENE_SEC)", () => {
  const cues = parseScript("🎬 Three steps\n🗣️ one two three\n🎬 The next one\n🗣️ eight nine");
  const [steps, next] = cues as [(typeof cues)[number], (typeof cues)[number]];
  const aligned: AlignedCue[] = [
    { cue: steps, startWord: 0, endWord: 2, score: 1 },
    { cue: next, startWord: 8, endWord: 9, score: 1 },
  ];
  const moment = (startWord: number, endWord: number): Moment => ({
    startWord,
    endWord,
    purpose: "p",
    onScreenCopy: "c",
    sceneKind: "TitleCard",
  });
  const scene = (id: string, startWord: number, endWord: number): Scene => ({
    id,
    anchor: { startWord, endWord },
    layout: "full-bleed",
    component: "TitleCard",
    props: {},
    overrides: {},
  });
  // Half-second words from 1.0 s: the line "one two three" is 1.5 s.
  const wordTimes = Array.from({ length: 10 }, (_, i) => ({ start: 1 + i * 0.5, end: 1.5 + i * 0.5 }));
  const outcomes = cueOutcomes({
    cues,
    aligned,
    skipped: [],
    // The first scene was held to word 7, past its line's last word (2).
    moments: [moment(0, 7), moment(8, 9)],
    scenes: [scene("scene-0", 0, 7), scene("scene-1", 8, 9)],
    timed: [
      { id: "scene-0", startSec: 0.7, endSec: 5 },
      { id: "scene-1", startSec: 5.1, endSec: 6.5 },
    ],
    dropped: [],
    shortened: [],
    wordTimes,
  });

  it("a scene held past its line still matches its cue, and says how long the line was and the scene is", () => {
    expect(outcomes.map((o) => o.status)).toEqual(["placed", "placed"]);
    expect(outcomes[0]).toMatchObject({ component: "TitleCard", startSec: 0.7, lengthened: { fromSec: 1.5, toSec: 4.3 } });
    // A scene its line already filled carries no note at all.
    expect("lengthened" in outcomes[1]!).toBe(false);
  });

  it("prints the hold on the cue's line and counts it in the summary", () => {
    const lines = formatCueReport(outcomes).split("\n");
    expect(lines[1]).toMatch(/^ {2}line 1 +placed +TitleCard at 0\.7s, held 4\.3s for a 1\.5s line — "Three steps"$/);
    expect(lines[2]).toMatch(/placed +TitleCard at 5\.1s — "The next one"$/);
    expect(lines.at(-1)).toBe("placed 2 of 2 (1 lengthened) · skipped 0 · reported 0");
  });

  it("a footage cue's moment is found by its own words, so it still reads as footage", () => {
    const out = cueOutcomes({
      cues,
      aligned,
      skipped: [],
      moments: [moment(0, 2), { ...moment(8, 9), sceneKind: "none" }],
      scenes: [scene("scene-0", 0, 2)],
      timed: [{ id: "scene-0", startSec: 0.7, endSec: 2.5 }],
      dropped: [],
      shortened: [],
      wordTimes,
    });
    expect(out.map((o) => o.status)).toEqual(["placed", "reported"]);
  });
});

describe("keptWordTimes (the output clock the minimum scene length is measured on)", () => {
  const words = [0, 1, 2, 3].map((t) => ({ start: t + 0.1, end: t + 0.9 }));
  // Source second 1-2 removed: word 1 is cut, words 2-3 move 1 s earlier.
  const map = new TimeMap([
    { srcIn: 0, srcOut: 1, kind: "keep" },
    { srcIn: 1, srcOut: 2, kind: "remove", reason: "filler", confidence: 1 },
    { srcIn: 2, srcOut: 4, kind: "keep" },
  ]);

  it("gives kept words their output times and cut words null", () => {
    const times = keptWordTimes(words, new Set([1]), map);
    expect(times[0]).toEqual({ start: 0.1, end: 0.9 });
    expect(times[1]).toBeNull();
    expect(times[2]!.start).toBeCloseTo(1.1);
    expect(times[3]!.end).toBeCloseTo(2.9);
  });

  it("a word the cut set names is null even if the map still has a sliver of it", () => {
    // The aligner skips every word in the cut set; a scene must not end on one.
    expect(keptWordTimes(words, new Set([0]), map)[0]).toBeNull();
  });
});

describe("replanScriptArgs", () => {
  it("points --script at the stored copy, replacing the recorded path", () => {
    expect(
      replanScriptArgs(["produce", "in.mp4", "--script", "/videos/s.md", "--no-captions"], "/w/script.md"),
    ).toEqual(["produce", "in.mp4", "--no-captions", "--script", "/w/script.md"]);
  });

  it("drops a --scenes pin a previous editor Render recorded, value and all", () => {
    expect(
      replanScriptArgs(["produce", "in.mp4", "--scenes", "/w/scenes-reviewed.json", "--aspect", "16:9"], "/w/script.md"),
    ).toEqual(["produce", "in.mp4", "--aspect", "16:9", "--script", "/w/script.md"]);
  });
});

describe("scriptPlanCut (the cut a script aligns against, §158 2026-11-16)", () => {
  // Six one-second words; the automatic cut removes the third (a filler).
  const words = [0, 1, 2, 3, 4, 5].map((t) => ({ start: t + 0.1, end: t + 0.9 }));
  const auto: Segment[] = [
    { srcIn: 0, srcOut: 2, kind: "keep" },
    { srcIn: 2, srcOut: 3, kind: "remove", reason: "filler", confidence: 1 },
    { srcIn: 3, srcOut: 6, kind: "keep" },
  ];
  const doc = (raw: unknown) => OverrideDocSchema.parse(raw);
  const cut = (raw: unknown, priorMap: TimeMap | null = null) =>
    [...scriptPlanCut({ words, cutlist: auto, doc: doc(raw), priorMap })].sort((a, b) => a - b);

  it("with no overrides it is the automatic cut, exactly", () => {
    expect(cut({})).toEqual([...cutWordIndices(words, auto)]);
    expect(cut({})).toEqual([2]);
  });

  it("a user cut removes the words under it", () => {
    expect(cut({ cuts: [{ startSec: 3, endSec: 4, src: { startSec: 4, endSec: 5 } }] })).toEqual([2, 4]);
  });

  it("a dismissed proposal revives the words the automatic cut removed", () => {
    expect(cut({ cleanup: { dismissed: [{ srcIn: 2.2, srcOut: 2.8 }] } })).toEqual([]);
  });

  it("cleanup vetoes are honoured, one span or a whole reason", () => {
    expect(cut({ cleanup: { kept: [{ srcIn: 2.2, srcOut: 2.8 }] } })).toEqual([]);
    expect(cut({ cleanup: { reasons: { filler: false } } })).toEqual([]);
  });

  it("a user cut over a vetoed span still cuts (vetoes first, then cuts — produce's order)", () => {
    expect(
      cut({
        cleanup: { kept: [{ srcIn: 2, srcOut: 3 }] },
        cuts: [{ startSec: 2, endSec: 3, src: { startSec: 2, endSec: 3 } }],
      }),
    ).toEqual([2]);
  });

  it("is the cut of `scriptPlanCutlist`, the cutlist whose clock the minimum length is measured on", () => {
    const raw = { cuts: [{ startSec: 3, endSec: 4, src: { startSec: 4, endSec: 5 } }] };
    const cutlist = scriptPlanCutlist({ words, cutlist: auto, doc: doc(raw), priorMap: null });
    expect([...cutWordIndices(words, cutlist)].sort((a, b) => a - b)).toEqual(cut(raw));
  });

  it("a src-less cut is read in the frame the user drew it in, the prior render's", () => {
    // The prior render had dropped the first second, so its output 0–1 is
    // source 1–2: word 1, not word 0.
    const prior = new TimeMap([
      { srcIn: 0, srcOut: 1, kind: "remove", reason: "user", confidence: 1 },
      { srcIn: 1, srcOut: 6, kind: "keep" },
    ]);
    expect(cut({ cuts: [{ startSec: 0, endSec: 1 }] }, prior)).toEqual([1, 2]);
  });
});
