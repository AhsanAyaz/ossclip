import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { produce } from "../src/produce";

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
}
interface Artefacts {
  workdir: string;
  production: { sfx?: { level: string; placements: Array<{ soundId: string; word: number }> } };
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
    opts: { sfx?: boolean; sfxLevel?: "subtle" | "normal" | "meme" },
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
});
