import { z } from "zod/v4";

/**
 * The `--grade` color pipeline's render half (core's color-grade.ts owns the
 * math: `gradeToSvgFilterSpec` decomposes the grade into per-channel transfer
 * tables plus one 5x4 color matrix). This module is the props gate, the
 * filter id and the CSS `filter:` composition — everything about the SVG
 * filter that is assertable without a DOM.
 *
 * Pure and JSX-free (house rule, `sfx-track.ts`'s posture): the component
 * just serializes these values into `<feFuncR tableValues>` and friends.
 */

/**
 * The precomputed spec, verbatim from `gradeToSvgFilterSpec`: 0..1 transfer
 * table samples per channel, and a row-major 5x4 feColorMatrix. Zod (parse,
 * never coerce, CLAUDE.md) rather than the neighbours' hand-rolled checks
 * because the shape is four numeric arrays — exactly what a schema states
 * more legibly than a loop. zod/v4's `z.number()` already refuses NaN and
 * ±Infinity, which is the whole finiteness story a hand parser would need.
 */
const colorGradeSchema = z.object({
  tableR: z.array(z.number()),
  tableG: z.array(z.number()),
  tableB: z.array(z.number()),
  // 20 exactly: feColorMatrix silently renders NOTHING (transparent output)
  // on a malformed `values` list, which reads as "the video vanished", not
  // "the grade is off" — so a truncated matrix must fail here instead.
  colorMatrix: z.array(z.number()).length(20),
});

export type ColorGradeProps = z.infer<typeof colorGradeSchema>;

/**
 * Whether a render-props `colorGrade` field is a spec this renderer will
 * mount — `punchPropsFor`'s posture: render-props.json is user-visible and
 * hand-editable, every pre-feature file has no key at all, and a mangled
 * spec must fall back to NO grade (zero new DOM) rather than an feColorMatrix
 * that blanks the picture or tables full of `undefined`.
 */
export function colorGradePropsFor(value: unknown): ColorGradeProps | null {
  const parsed = colorGradeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A DOM id for the filter, derived from the VALUES (FNV-1a over the sample
 * list) rather than from a counter or a random suffix: SVG filter ids are
 * document-global, and if two stages ever share a document (editor preview
 * next to a thumbnail), a value-derived id makes collision harmless — equal
 * ids mean equal filter definitions, so whichever `<filter>` wins the lookup
 * applies the same grade. A counter would make the collision silently apply
 * one stage's grade to the other.
 */
export function colorGradeFilterId(spec: ColorGradeProps): string {
  const values = [...spec.tableR, ...spec.tableG, ...spec.tableB, ...spec.colorMatrix];
  let hash = 0x811c9dc5;
  for (const v of values) {
    const s = String(v);
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `ossclip-grade-${(hash >>> 0).toString(16)}`;
}

/**
 * The video slot's composed `filter:` value. One CSS filter list takes both
 * an SVG `url()` reference and CSS filter functions; the grade goes FIRST so
 * the blur softens the graded picture — blurring first would average raw
 * pixels and then re-map the averages, visibly haloing hard edges. The 0.5px
 * blur floor predates the grade (VideoStage has always skipped sub-pixel
 * blurs) and is kept so a grade-less render emits the exact string it always
 * did.
 */
export function stageFilterFor(gradeId: string | null, blurPx: number): string | undefined {
  const parts: string[] = [];
  if (gradeId) parts.push(`url(#${gradeId})`);
  if (blurPx > 0.5) parts.push(`blur(${blurPx}px)`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
