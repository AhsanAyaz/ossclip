import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExportFormatSchema, defaultExportPath, runAnalyze } from "../src/analyze";

/**
 * `ossclip analyze` (next-directions §2; design doc 2026-08-12): the analyzer
 * without the renderer. Pure parts first; then a behavioural run through the
 * REAL pipeline (produce-timing.test.ts's harness pattern — injected
 * transcript, no LLM, no render) asserting the export actually lands beside
 * the input and parses.
 */

describe("ExportFormatSchema", () => {
  it("accepts fcpxml, resolve-edl, premiere-xml and premiere-project", () => {
    expect(ExportFormatSchema.parse("fcpxml")).toBe("fcpxml");
    expect(ExportFormatSchema.parse("resolve-edl")).toBe("resolve-edl");
    expect(ExportFormatSchema.parse("premiere-xml")).toBe("premiere-xml");
    expect(ExportFormatSchema.parse("premiere-project")).toBe("premiere-project");
  });

  it("a typo is an error, never a silent fallback (CLAUDE.md: parse, don't coerce)", () => {
    expect(() => ExportFormatSchema.parse("fcpxmll")).toThrow();
    // Bare "edl" stays an error on purpose: this is Resolve's marker-EDL
    // dialect, not a cut EDL — when a real cut EDL ships it gets its own
    // name, and "edl" meaning either would be an ambiguity forever (§142).
    expect(() => ExportFormatSchema.parse("edl")).toThrow();
  });
});

describe("defaultExportPath", () => {
  it("lands beside the input, extension swapped per format", () => {
    expect(defaultExportPath("/takes/demo.mp4", "fcpxml")).toBe("/takes/demo.fcpxml");
    // The FILE extension is .edl — "demo.resolve-edl" would import nowhere.
    expect(defaultExportPath("/takes/demo.mp4", "resolve-edl")).toBe("/takes/demo.edl");
    // Premiere's import dialog filters on .xml.
    expect(defaultExportPath("/takes/demo.mp4", "premiere-xml")).toBe("/takes/demo.xml");
    // The pre-cut project is also xmeml, so also .xml; the SRT sidecar is derived.
    // Distinct from premiere-xml's default: both are importable .xml, but a
    // shared default path would silently clobber yesterday's marker export.
    expect(defaultExportPath("/takes/demo.mp4", "premiere-project")).toBe("/takes/demo.project.xml");
  });

  it("an extensionless input just gains the suffix", () => {
    expect(defaultExportPath("/takes/demo", "fcpxml")).toBe("/takes/demo.fcpxml");
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("runAnalyze — behavioural", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-analyze-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=6",
      "-f", "lavfi", "-i",
      // Two sine bursts with a >1s gap of silence between them — the gap is
      // what guarantees at least one silence cut for the marker assertion.
      "aevalsrc=if(lt(mod(t\\,3)\\,1.5)\\,sin(440*2*PI*t)\\,0.001*sin(440*2*PI*t)):d=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: [
          { text: "hello", start: 0.3, end: 0.7 },
          { text: "there", start: 0.8, end: 1.2 },
          { text: "again", start: 3.2, end: 3.7 },
          { text: "friends", start: 3.8, end: 4.3 },
        ],
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "runs the no-render pipeline and writes a parseable FCPXML beside the input",
    async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = await runAnalyze(join(dir, "take.mp4"), {
          cleanup: "standard",
          format: "fcpxml",
          transcript: join(dir, "transcript.json"),
          workdir: join(dir, "work"),
        });
        expect(result.outPath).toBe(join(dir, "take.fcpxml"));
        const xml = readFileSync(result.outPath, "utf8");
        const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
        expect(doc.querySelector("parsererror")).toBeNull();
        const markers = doc.querySelectorAll("marker");
        // The synthetic take has real dead air, so the cutlist cannot be empty.
        expect(markers.length).toBeGreaterThan(0);
        // Cut markers + kept-pause markers together are what's in the file
        // (§142 round 2); the counts are surfaced separately so the CLI can
        // say which is which.
        expect(result.markerCount + result.pauseCount).toBe(markers.length);
        expect(result.pauseCount).toBeGreaterThanOrEqual(0);
        // No render, no LLM was involved in getting here.
        expect(result.phaseTimings.render).toBeUndefined();
        expect(result.phaseTimings.llm).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    },
    120_000,
  );

  it(
    "premiere-project writes BOTH files: an xmeml with the cuts applied and an SRT sidecar",
    async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = await runAnalyze(join(dir, "take.mp4"), {
          cleanup: "standard",
          format: "premiere-project",
          transcript: join(dir, "transcript.json"),
          workdir: join(dir, "work-project"),
        });
        expect(result.outPath).toBe(join(dir, "take.project.xml"));
        expect(result.srtPath).toBe(join(dir, "take.project.srt"));
        const xml = readFileSync(result.outPath, "utf8");
        const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
        expect(doc.querySelector("parsererror")).toBeNull();
        // Cuts APPLIED: the silence gap guarantees at least two kept spans,
        // each a clipitem carrying the Basic Motion transform.
        const clips = doc.querySelectorAll("video > track > clipitem");
        expect(clips.length).toBeGreaterThan(1);
        expect(doc.querySelector("effectid")!.textContent).toBe("basic");
        const srt = readFileSync(result.srtPath!, "utf8");
        expect(srt).toMatch(/\d+\n\d\d:\d\d:\d\d,\d\d\d --> /);
      } finally {
        spy.mockRestore();
      }
    },
    120_000,
  );
});
