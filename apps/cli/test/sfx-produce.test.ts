import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { priorSfxPlan, produce } from "../src/produce";

/**
 * `--sfx` end to end through the real pipeline, on the offline provider
 * (`--llm mock`), which is the run verify-ossclip makes its determinism claim
 * about: production.json carries the PLAN (word anchors), render-props.json
 * the resolved CUES (output instants), report.txt the one accounting line —
 * and a re-run answers from the cache with the same cue list.
 *
 * The no-zoom harness's shape: a synthesized take plus a hand-written
 * transcript, so nothing here depends on whisper or a fixture build.
 */
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface Props {
  sfxCues?: Array<{ soundFile: string; atSec: number; gain: number }>;
  /** The resolved scene windows — where a scene-anchored cue must land. */
  sceneCues?: Array<{ id: string; startSec: number; endSec: number }>;
}
interface Artefacts {
  workdir: string;
  production: {
    sfx?: {
      level: string;
      placements: Array<{ soundId: string; word: number; gain?: number; sceneId?: string }>;
    };
  };
  props: Props;
  report: string;
  logs: string;
}

describe.skipIf(!hasFfmpeg)("--sfx end to end", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-sfx-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    // Ten words spread over the take, each with speech around it — enough
    // runtime for a level's budget to be more than its floor.
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: Array.from({ length: 10 }, (_, i) => ({
          text: `word${i}`,
          start: 0.4 + i * 1.1,
          end: 0.4 + i * 1.1 + 0.8,
        })),
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (
    opts: {
      sfx?: boolean;
      sfxLevel?: "subtle" | "normal" | "meme";
      /** The editor's Render shape: a pinned plan, no `--produce`. */
      scenes?: string;
      produce?: boolean;
    },
    workdir: string,
  ): Promise<Artefacts> => {
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
    try {
      const result = await produce(join(dir, "take.mp4"), {
        cleanup: "standard",
        render: false,
        mezzanine: false,
        transcript: join(dir, "transcript.json"),
        workdir: join(dir, workdir),
        produce: true,
        provider: "mock",
        ...opts,
      });
      const read = (name: string) => readFileSync(join(result.workdir, name), "utf8");
      return {
        workdir: result.workdir,
        production: JSON.parse(read("production.json")) as Artefacts["production"],
        props: JSON.parse(read("render-props.json")) as Props,
        report: read("report.txt"),
        logs: logs.join("\n"),
      };
    } finally {
      spy.mockRestore();
    }
  };

  it(
    "plans, stages and reports sound effects",
    async () => {
      const out = await run({ sfx: true, sfxLevel: "meme" }, "work-sfx");

      // production.json keeps the PLAN, in word anchors — the form that
      // survives a re-cut and the form the editor will edit (Phase 3).
      expect(out.production.sfx?.level).toBe("meme");
      expect(out.production.sfx!.placements.length).toBeGreaterThan(0);
      for (const p of out.production.sfx!.placements) {
        expect(Number.isInteger(p.word)).toBe(true);
        expect(p.soundId).toMatch(/^[a-z0-9-]+$/);
      }

      // render-props.json keeps the resolved CUES, in output seconds.
      const cues = out.props.sfxCues ?? [];
      expect(cues.length).toBeGreaterThan(0);
      for (const c of cues) {
        expect(c.soundFile).toMatch(/^sfx\/[a-z0-9-]+\.\w+$/);
        expect(c.atSec).toBeGreaterThanOrEqual(0);
        expect(c.gain).toBeGreaterThan(0);
        // Staged where the render (and `ossclip edit`) will look for it.
        expect(existsSync(join(out.workdir, ...c.soundFile.split("/")))).toBe(true);
      }

      // …and report.txt carries the ONE accounting line the console printed —
      // same formatter, so the artefact people forward cannot disagree with
      // the terminal about what the run did (§118b's contract).
      expect(out.report).toMatch(/sfx: \d+ of \d+ planned placed \(level meme/);
    },
    180_000,
  );

  it(
    "a re-run answers from the placement cache with the same cues",
    async () => {
      // The determinism claim: no second LLM call, byte-identical cue list.
      const first = await run({ sfx: true, sfxLevel: "meme" }, "work-cache");
      expect(readdirSync(first.workdir).some((f) => /^sfx-.*\.json$/.test(f))).toBe(true);
      const second = await run({ sfx: true, sfxLevel: "meme" }, "work-cache");
      // Said out loud, and actually served from disk — with a deterministic
      // mock, equal cues alone would not prove the cache was read.
      expect(second.logs).toContain("sfx cached");
      expect(second.props.sfxCues).toEqual(first.props.sfxCues);
      expect(second.production.sfx).toEqual(first.production.sfx);
    },
    180_000,
  );

  it(
    "a run without --sfx writes neither the field nor the cues",
    async () => {
      // Absent-means-off: a no-sfx workdir is byte-compatible with a
      // pre-feature one, and the composition mounts no audio track at all.
      const out = await run({}, "work-off");
      expect("sfx" in out.production).toBe(false);
      expect("sfxCues" in out.props).toBe(false);
      expect(out.report).not.toContain("sfx:");
    },
    180_000,
  );

  /**
   * The editor round trip (Phase 3): Render pins the reviewed plan with
   * `--scenes` and drops `--produce`, so the run never reaches the placement
   * call — and the reviewed state it must reproduce is the PRIOR
   * production.json's plan with overrides.json applied on top.
   */
  it(
    "a --scenes replay carries the reviewed plan forward and applies the editor's edits",
    async () => {
      const first = await run({ sfx: true, sfxLevel: "meme" }, "work-carry");
      const planned = first.production.sfx!.placements;
      // The mapping the edits below are written against: with nothing cut out
      // from under them, every planned placement is a cue, in word order.
      expect(first.props.sfxCues).toHaveLength(planned.length);
      expect(planned.length).toBeGreaterThanOrEqual(2);

      // A mute, a gain and one placement of the user's own — written the way
      // the editor writes them: keyed by `${soundId}@${word}`, through the one
      // sanctioned overrides.json.
      const muted = planned[0]!;
      const regained = planned[1]!;
      writeFileSync(
        join(first.workdir, "overrides.json"),
        JSON.stringify({
          sfx: {
            edits: {
              [`${muted.soundId}@${muted.word}`]: { muted: true },
              [`${regained.soundId}@${regained.word}`]: { gain: 0.25 },
            },
            added: [{ id: "u1", soundId: muted.soundId, word: muted.word, gain: 0.5 }],
          },
        }),
      );
      // The editor's own Render argv: a pinned plan, no producer.
      const scenesPath = join(dir, "scenes-reviewed.json");
      writeFileSync(scenesPath, "[]");
      const replay = await run(
        { sfx: true, sfxLevel: "meme", scenes: scenesPath, produce: false },
        "work-carry",
      );

      expect(replay.logs).toContain("sfx carried forward from the reviewed plan");
      // production.json keeps the MODEL's plan, untouched by the edit layer —
      // the edit keys are derived from it, so folding them in would re-key the
      // user's whole layer on the next run and stale all of it.
      expect(replay.production.sfx).toEqual(first.production.sfx);

      const cues = replay.props.sfxCues!;
      // One placement muted, one added at the same word: the count holds, and
      // the added cue plays at the muted one's instant with ITS gain.
      expect(cues).toHaveLength(planned.length);
      const before = first.props.sfxCues!;
      const mutedCue = before[0]!;
      const added = cues.find((c) => c.atSec === mutedCue.atSec)!;
      expect(added.soundFile).toBe(mutedCue.soundFile);
      // The sound's own gain times the placement's — resolved once, in the
      // resolver — so the edited gain shows up as a RATIO of the planned cue.
      expect(added.gain).toBeCloseTo(mutedCue.gain * 0.5, 6);
      const regainedCue = cues.find((c) => c.atSec === before[1]!.atSec)!;
      expect(regainedCue.gain).toBeCloseTo(
        (before[1]!.gain / (regained.gain ?? 1)) * 0.25,
        6,
      );

      // The chain does not break: the plan written back is the one the NEXT
      // replay carries forward, with the same edits still on top.
      const again = await run(
        { sfx: true, sfxLevel: "meme", scenes: scenesPath, produce: false },
        "work-carry",
      );
      expect(again.props.sfxCues).toEqual(cues);
    },
    180_000,
  );

  it(
    "reports a stale edit key instead of applying it to whatever is there now",
    async () => {
      const first = await run({ sfx: true, sfxLevel: "meme" }, "work-stale");
      writeFileSync(
        join(first.workdir, "overrides.json"),
        JSON.stringify({ sfx: { edits: { "no-such-sound@3": { muted: true } } } }),
      );
      const scenesPath = join(dir, "scenes-reviewed.json");
      writeFileSync(scenesPath, "[]");
      const replay = await run(
        { sfx: true, sfxLevel: "meme", scenes: scenesPath, produce: false },
        "work-stale",
      );
      expect(replay.logs).toContain('sfx edit "no-such-sound@3" no longer matches');
      // The user's lost work costs a warning, never the run or the rest of the
      // sound design.
      expect(replay.props.sfxCues).toEqual(first.props.sfxCues);
    },
    180_000,
  );

  /**
   * The scene anchor end to end (field report, 2026-08-29): a whoosh
   * rationalised "as the TitleCard enters" used to fire at a WORD, so the
   * moment the user moved the card in the editor the sound stayed behind.
   *
   * Driven through the `--scenes` replay because that IS the editor's Render
   * argv: a pinned scene plan plus overrides.json, which is exactly the shape
   * the field failure arrived in.
   */
  it(
    "a scene-anchored placement follows the scene when the user retimes it",
    async () => {
      const first = await run({ sfx: true, sfxLevel: "meme" }, "work-scene");
      const planned = first.production.sfx!.placements;
      expect(planned.length).toBeGreaterThanOrEqual(1);

      // The scene the sound will be linked to, pinned the way the editor pins
      // a reviewed plan. Anchored to words 5–7, deliberately NOT to the word
      // the linked placement sits on: with the two coinciding, "followed the
      // scene" and "stayed on its word" would be the same number and the test
      // would pass without the feature (it did, at anchor 2–4).
      const scenesPath = join(dir, "scenes-linked.json");
      writeFileSync(
        scenesPath,
        JSON.stringify([
          {
            id: "scene-0",
            anchor: { startWord: 5, endWord: 7 },
            layout: "pip-bubble",
            component: "TitleCard",
            props: { title: "THE POINT" },
            overrides: {},
          },
        ]),
      );
      // The link itself, written into the plan the replay carries forward —
      // production.json is where `sceneId` lives, and `priorSfxPlan` parses it
      // back out through `ProductionSfxSchema`.
      const productionPath = join(first.workdir, "production.json");
      const doc = JSON.parse(readFileSync(productionPath, "utf8")) as Record<string, unknown>;
      const sfx = doc.sfx as Artefacts["production"]["sfx"];
      const linked = sfx!.placements[0]!;
      linked.sceneId = "scene-0";
      writeFileSync(productionPath, JSON.stringify(doc));

      const asPlanned = await run(
        { sfx: true, sfxLevel: "meme", scenes: scenesPath, produce: false },
        "work-scene",
      );
      const sceneAt = (a: Artefacts): number =>
        a.props.sceneCues!.find((c) => c.id === "scene-0")!.startSec;
      const cueFor = (a: Artefacts): number => {
        const file = `sfx/${linked.soundId}`;
        return a.props.sfxCues!.find((c) => c.soundFile.startsWith(file))!.atSec;
      };
      // Already the SCENE's instant, not the word's — the link is live before
      // anybody edits anything. The second assertion is what stops the first
      // from passing vacuously: `first` resolved this same placement with NO
      // link, on the same cut and the same clock, so its instant is the WORD's
      // and the two must not be the same number.
      expect(cueFor(asPlanned)).toBeCloseTo(sceneAt(asPlanned), 5);
      expect(cueFor(first)).not.toBeCloseTo(sceneAt(asPlanned), 3);
      expect(asPlanned.logs).not.toContain("gone — using word anchor");

      // Now the gesture that used to break it: the user drags the scene.
      const moved = sceneAt(asPlanned) + 2;
      writeFileSync(
        join(first.workdir, "overrides.json"),
        JSON.stringify({
          scenes: { "scene-0": { timing: { startSec: moved, endSec: moved + 2 } } },
        }),
      );
      const retimed = await run(
        { sfx: true, sfxLevel: "meme", scenes: scenesPath, produce: false },
        "work-scene",
      );
      // The scene really moved…
      expect(sceneAt(retimed)).toBeCloseTo(moved, 5);
      expect(sceneAt(retimed)).not.toBeCloseTo(sceneAt(asPlanned), 3);
      // …and the sound went with it. This is the whole feature.
      expect(cueFor(retimed)).toBeCloseTo(sceneAt(retimed), 5);
      // production.json still stores the MODEL's plan — a word anchor and the
      // link, never the resolved second (the form that survives a re-cut).
      expect(retimed.production.sfx!.placements[0]).toEqual(linked);
    },
    180_000,
  );

  it(
    "a scene-anchored placement falls back to its word, loudly, when the scene is gone",
    async () => {
      const first = await run({ sfx: true, sfxLevel: "meme" }, "work-scene-gone");
      const productionPath = join(first.workdir, "production.json");
      const doc = JSON.parse(readFileSync(productionPath, "utf8")) as Record<string, unknown>;
      const sfx = doc.sfx as Artefacts["production"]["sfx"];
      // A scene id no plan will ever have — a deleted or re-planned graphic
      // reaches the resolver looking exactly like this.
      sfx!.placements[0]!.sceneId = "scene-gone";
      writeFileSync(productionPath, JSON.stringify(doc));

      const scenesPath = join(dir, "scenes-reviewed.json");
      writeFileSync(scenesPath, "[]");
      const replay = await run(
        { sfx: true, sfxLevel: "meme", scenes: scenesPath, produce: false },
        "work-scene-gone",
      );
      expect(replay.logs).toContain('scene scene-gone gone — using word anchor');
      // The sound is NOT lost: `word` is required precisely so a broken link
      // costs the sync intent and nothing else, and the cue list is unchanged.
      expect(replay.props.sfxCues).toEqual(first.props.sfxCues);
      // …and the accounting does not price the issue as a casualty.
      expect(replay.report).toMatch(/sfx: (\d+) of \1 planned placed \(level meme\)/);
    },
    180_000,
  );

  it(
    "a --scenes run with NO prior plan still says why there are no effects",
    async () => {
      const scenesPath = join(dir, "scenes-reviewed.json");
      writeFileSync(scenesPath, "[]");
      const out = await run(
        { sfx: true, sfxLevel: "meme", scenes: scenesPath, produce: false },
        "work-noprior",
      );
      expect(out.logs).toContain("sound effects are placed against the producer's beat sheet");
      expect("sfx" in out.production).toBe(false);
      expect("sfxCues" in out.props).toBe(false);
    },
    180_000,
  );
});

/**
 * The carried-forward read on its own — NOT behind the ffmpeg gate, because
 * the rule it pins (parse, never trust; a bad record means "no prior sound
 * design", never a crash) is the one thing about this path that must hold on
 * every runner.
 */
describe("priorSfxPlan (the reviewed plan a --scenes replay carries)", () => {
  const workdirWith = (production: unknown): string => {
    const work = mkdtempSync(join(tmpdir(), "ossclip-prior-sfx-"));
    if (production !== undefined) {
      writeFileSync(join(work, "production.json"), JSON.stringify(production));
    }
    return work;
  };

  it("reads the plan the last run wrote", () => {
    const work = workdirWith({
      sfx: { level: "meme", placements: [{ soundId: "ding", word: 4, gain: 0.5 }] },
    });
    expect(priorSfxPlan(work)).toEqual({
      level: "meme",
      placements: [{ soundId: "ding", word: 4, gain: 0.5 }],
    });
    rmSync(work, { recursive: true, force: true });
  });

  it("a missing, unreadable or sfx-less file all mean no prior sound design", () => {
    const empty = mkdtempSync(join(tmpdir(), "ossclip-prior-sfx-"));
    expect(priorSfxPlan(empty)).toBeUndefined();
    const corrupt = workdirWith(undefined);
    writeFileSync(join(corrupt, "production.json"), "{not json");
    expect(priorSfxPlan(corrupt)).toBeUndefined();
    expect(priorSfxPlan(workdirWith({ version: 1 }))).toBeUndefined();
  });

  it("parses, never coerces — a hand-edited level is no level at all", () => {
    // production.json is as hand-editable as anything else in the workdir,
    // and a "MEME" reaching the report as a level is the coercion CLAUDE.md
    // refuses. A refused record degrades to "no prior plan", which prints the
    // actionable notice rather than rendering something nobody planned.
    expect(priorSfxPlan(workdirWith({ sfx: { level: "MEME", placements: [] } }))).toBeUndefined();
    expect(
      priorSfxPlan(workdirWith({ sfx: { level: "normal", placements: [{ soundId: "x", word: 1.5 }] } })),
    ).toBeUndefined();
  });
});
