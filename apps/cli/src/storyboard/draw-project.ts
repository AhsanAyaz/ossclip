/**
 * The project a shot is drawn for when the editor asks (plan B2a Task 2;
 * §169): the frame, the frame rate and the theme as the editor shows them
 * now. `ossclip draw` reads production.json (`drawProjectFrom`), which holds
 * the theme of the last produce run; in the editor the author may have
 * changed a colour since, and a shot drawn in the old one would not match
 * the video it is approved into. Pure, on the two files' text, so the
 * server's reads are its own and a test needs no workdir.
 */
import { z } from "zod/v4";
import { OverrideDocSchema, ThemeSchema, emptyOverrideDoc, resolveTheme, type OverrideDoc } from "@ossclip/core";
import type { DrawProject } from "../draw/draw-command";

/**
 * A render-props.json or overrides.json that cannot be used. Its own class
 * so the editor's endpoints (Task 4) can answer "this file is broken" apart
 * from a failed draw.
 */
export class StoryboardProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardProjectError";
  }
}

/**
 * The slice of render-props.json a draw needs, parsed rather than cast: the
 * `KitRenderPropsSchema` and `CoverRenderPropsSchema` posture, one slice per
 * reader, since the whole file has no schema of its own.
 *
 * `settings` is the COMPOSITION's frame, which is what produce writes there
 * (produce.ts, 2026-08-27): a clip scene is laid out in that frame, so the
 * clip is drawn at it, not at the scaled file size production.json's
 * `render` holds under `--resolution`.
 *
 * `baseTheme` is the theme before overrides.json (F6); `theme` is the one
 * the last run rendered, overrides baked in. The overrides go over the base,
 * as the editor applies them: laid over `theme`, a colour the author reset
 * would stay. `baseTheme` is optional because a render-props.json from
 * before it existed has only `theme`, which is then the best base there is.
 */
const DrawRenderPropsSchema = z.object({
  settings: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  theme: ThemeSchema,
  baseTheme: ThemeSchema.optional(),
});

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new StoryboardProjectError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Frame, fps and the theme as the editor shows it now: render-props.json's
 * `settings` and `baseTheme ?? theme`, with the saved overrides.json applied
 * through `resolveTheme`. `overridesText` is null when the workdir has no
 * overrides.json.
 *
 * The SAVED overrides, not the editor's unsaved document: the server cannot
 * see the latter, and the replay that puts an approved clip into the video
 * reads the saved file too (plan B2a Review Focus 4). An overrides.json that
 * fails its schema is refused rather than read as empty, as produce refuses
 * it: drawing in the base theme would quietly draw the wrong colours.
 */
export function liveDrawProject(renderPropsText: string, overridesText: string | null): DrawProject {
  const props = DrawRenderPropsSchema.safeParse(parseJson(renderPropsText, "render-props.json"));
  if (!props.success) throw new StoryboardProjectError(`render-props.json is not valid: ${props.error.message}`);
  let doc: OverrideDoc = emptyOverrideDoc();
  if (overridesText !== null) {
    const parsed = OverrideDocSchema.safeParse(parseJson(overridesText, "overrides.json"));
    if (!parsed.success) throw new StoryboardProjectError(`overrides.json is not valid: ${parsed.error.message}`);
    doc = parsed.data;
  }
  const { width, height, fps } = props.data.settings;
  return { width, height, fps, theme: resolveTheme(props.data.baseTheme ?? props.data.theme, doc) };
}
