import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  ProductionSchema,
  buildFcpxmlMarkers,
  buildPremiereProject,
  buildPremiereXmlMarkers,
  buildResolveMarkerEdl,
  keptPauses,
  type CleanupLevel,
} from "@ossclip/core";
import { produce } from "./produce";
import type { PhaseTimings } from "./phase-timing";

/**
 * `ossclip analyze` (next-directions §2–3; design doc
 * 2026-08-12-analyse-fcpxml-export-design.md): the analyzer without the
 * renderer. §140 measured the render at 85% of wall time on two machines —
 * this command is the product of skipping it: the same pipeline up to the
 * cut report (no LLM, no Remotion), plus an export file an editor's own NLE
 * can review. Markers, not applied cuts, by design — see the exporter.
 */

/**
 * zod enum, not a string: a typo'd `--format fcpxmll` must error naming the
 * choice, never fall back to a default that silently writes the wrong file
 * (CLAUDE.md's `--source-fit containn` rule, verbatim).
 *
 * `resolve-edl`, not `edl` (§142): it is Resolve's marker-EDL dialect —
 * markers with colours, for `Timeline → Import → Timeline Markers from EDL`
 * — not a cut EDL. A future cut EDL gets its own name; "edl" meaning either
 * would be a permanent ambiguity. It exists because Resolve's FCPXML import
 * silently drops clip markers (field-verified the day fcpxml shipped);
 * Premiere reads the fcpxml markers fine.
 */
export const ExportFormatSchema = z.enum([
  "fcpxml",
  "resolve-edl",
  "premiere-xml",
  // The pre-cut project: markers annotate an untouched take; this one applies
  // the cutlist and carries the render's camera motion as editable keyframes
  // (plan 2026-08-13). A distinct name, not a flag on premiere-xml — the two
  // answer different questions ("review my cuts" vs "hand me the edit").
  "premiere-project",
]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

/** The FILE extension per format — "demo.resolve-edl" would import nowhere. */
const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  fcpxml: "fcpxml",
  "resolve-edl": "edl",
  "premiere-xml": "xml",
  // NOT bare "xml": the marker format above already owns `<input>.xml`, and
  // an editor who exported markers yesterday and the project today would
  // silently clobber the file they sent their editor. Distinct default,
  // same importable extension.
  "premiere-project": "project.xml",
};

/**
 * The slice of `render-props.json` the project export needs — SELECTIVE on
 * purpose, and parsed rather than cast (CLAUDE.md): the file is user-visible
 * and hand-editable, so a truncated or tweaked one must error here with a
 * field name, not export a project with NaN trims. `srcStart` and the rest
 * of a caption word are deliberately not asked for: the SRT only needs text
 * and output-time bounds, and legacy files predate `srcStart` (§137).
 */
export const RenderPropsExportSchema = z.object({
  spans: z.array(
    z.object({
      srcIn: z.number(),
      srcOut: z.number(),
      outIn: z.number(),
      outOut: z.number(),
    }),
  ),
  captionLines: z.array(
    z.object({
      words: z.array(z.object({ text: z.string() })),
      start: z.number(),
      end: z.number(),
    }),
  ),
  zoomPlan: z.array(
    z.object({
      startSec: z.number(),
      endSec: z.number(),
      from: z.number(),
      to: z.number(),
    }),
  ),
  // Written only when the camera is OFF (produce's absent-means-default
  // contract) — absent must read as "motion on".
  staticCamera: z.boolean().optional(),
});

/** Same shape as produce's `defaultOutPath`: beside the input, new extension. */
export function defaultExportPath(input: string, format: ExportFormat): string {
  return input.replace(/(\.[^.]+)?$/, `.${FORMAT_EXTENSIONS[format]}`);
}

export interface AnalyzeOptions {
  cleanup: CleanupLevel;
  format: ExportFormat;
  out?: string;
  transcript?: string;
  workdir?: string;
  noiseDb?: number;
  whisperModel?: string;
  whisperLanguage?: string;
  blooperMarker?: string;
  collapseRetakes?: boolean;
  sort?: "name" | "mtime";
  sortExplicit?: boolean;
}

export interface AnalyzeResult {
  workdir: string;
  outPath: string;
  /** The SRT sidecar — present only for `premiere-project` (two-file format). */
  srtPath?: string;
  /** Suggested-cut markers — one per remove segment. */
  markerCount: number;
  /** Informational kept-pause markers (§142 round 2) — counted separately
   * so the CLI and telemetry can say which is which. */
  pauseCount: number;
  sourceDurationSec: number;
  phaseTimings: PhaseTimings;
}

/**
 * The I/O glue: run the existing no-render pipeline, read back the
 * `production.json` it wrote, hand it to the pure exporter, write the file.
 * The read-back goes through `ProductionSchema.parse` even though this very
 * run just wrote it — the file is user-visible and hand-editable, and a
 * truncated or tweaked one must error here, not export garbage markers.
 */
export async function runAnalyze(
  inputArg: string,
  opts: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const result = await produce(inputArg, {
    cleanup: opts.cleanup,
    transcript: opts.transcript,
    render: false,
    mezzanine: false,
    workdir: opts.workdir,
    noiseDb: opts.noiseDb,
    whisperModel: opts.whisperModel,
    whisperLanguage: opts.whisperLanguage,
    blooperMarker: opts.blooperMarker,
    collapseRetakes: opts.collapseRetakes,
    sort: opts.sort,
    sortExplicit: opts.sortExplicit,
    cover: false,
  });
  const production = ProductionSchema.parse(
    JSON.parse(await readFile(join(result.workdir, "production.json"), "utf8")),
  );
  const markerCount = (production.cutlist ?? []).filter((s) => s.kind === "remove").length;
  const pauseCount = keptPauses(production).length;
  const outPath = resolve(opts.out ?? defaultExportPath(resolve(inputArg), opts.format));

  if (opts.format === "premiere-project") {
    // The project export reads render-props.json, not just production.json:
    // spans/captions/zoom are the RENDER's own inputs, so the exported
    // project is the render, not a re-derivation of it. Same parse rule as
    // the production read-back above — the file is hand-editable.
    const props = RenderPropsExportSchema.parse(
      JSON.parse(await readFile(join(result.workdir, "render-props.json"), "utf8")),
    );
    const { xml, srt } = buildPremiereProject({
      production,
      spans: props.spans,
      captionLines: props.captionLines,
      zoomPlan: props.zoomPlan,
      staticCamera: props.staticCamera,
      // The OUTPUT frame — production.render already carries --aspect.
      frame: { width: production.render.width, height: production.render.height },
    });
    // Same basename, .srt — beside the xml so the pair travels together.
    const srtPath = outPath.replace(/(\.[^.]+)?$/, ".srt");
    await writeFile(outPath, xml);
    await writeFile(srtPath, srt);
    console.log(
      `✓ premiere-project → ${outPath} + ${srtPath} ` +
        `(cuts applied, camera motion as Basic Motion keyframes — in Premiere: ` +
        `File → Import the .xml; then import the .srt onto the timeline for captions)`,
    );
    return {
      workdir: result.workdir,
      outPath,
      srtPath,
      markerCount,
      pauseCount,
      sourceDurationSec: result.sourceDurationSec,
      phaseTimings: result.phaseTimings,
    };
  }

  // §142, learned the hard way in one field-test hour: each NLE gets its OWN
  // dialect. Premiere rejects modern fcpxml outright, Resolve's fcpxml import
  // silently drops markers — so fcpxml is for actual Final Cut Pro.
  const content =
    opts.format === "resolve-edl"
      ? buildResolveMarkerEdl(production)
      : opts.format === "premiere-xml"
        ? buildPremiereXmlMarkers(production)
        : buildFcpxmlMarkers(production);
  await writeFile(outPath, content);
  const detail =
    opts.format === "resolve-edl"
      ? "in Resolve: Media Pool → right-click your timeline → Timelines → Import → Timeline Markers from EDL"
      : opts.format === "premiere-xml"
        ? "in Premiere: File → Import, pick the .xml, relink media if offline"
        : "for Final Cut Pro; Premiere needs --format premiere-xml, Resolve --format resolve-edl";
  console.log(
    `✓ ${opts.format} → ${outPath} (${markerCount} cut marker${markerCount === 1 ? "" : "s"}` +
      `${pauseCount > 0 ? ` + ${pauseCount} kept-pause marker${pauseCount === 1 ? "" : "s"}` : ""} — ${detail})`,
  );
  return {
    workdir: result.workdir,
    outPath,
    markerCount,
    pauseCount,
    sourceDurationSec: result.sourceDurationSec,
    phaseTimings: result.phaseTimings,
  };
}
