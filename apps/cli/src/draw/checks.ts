/**
 * The checks every drawn version goes through, as one `DrawCheck` for core's
 * `drawShot` (storyboard design §5, plan Task 7; §167). In order, stopping at
 * the first stage that reports anything, because each stage is slower than
 * the one before and a later stage's message about code an earlier stage
 * already rejected is noise in the repair prompt:
 *
 *   1. the static check (pure, core): milliseconds, and it runs before the
 *      code touches disk, so code that names `fetch` is never written;
 *   2. the type check against the kit (a second or so);
 *   3. the bundle and three stills (seconds, a browser);
 *   4. the blank check on those stills.
 *
 * What is the scene's fault becomes an issue the LLM is shown; what is
 * ossclip's propagates (`drawShot`'s contract). A type check that throws is
 * an incomplete install (draw/typecheck.ts), and a bundle that fails after
 * the code passed the static and type checks is the bundler or the kit
 * failing, not something a redraw can fix: both reach the author as an
 * error instead of costing two repair calls that cannot succeed.
 */
import { checkDrawnScene, type DrawCheck, type DrawIssue } from "@ossclip/core";

/** A render failure's message, as far as the repair prompt quotes it: enough for the error and its first frames, not a whole webpack log. */
export const DRAW_RENDER_MESSAGE_MAX = 600;

/** The blank check's one issue (design §5 step 4). */
export const DRAW_BLANK_MESSAGE =
  "every frame is fully transparent: the scene drew nothing visible at any of the three still times";

/**
 * Thrown by a `renderStills` whose failure is ossclip's (the bundle), so the
 * check rethrows it instead of turning it into a render issue.
 */
export class DrawSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DrawSetupError";
  }
}

/** A rejected render as the one issue the LLM is shown (pure). */
export function renderIssue(err: unknown): DrawIssue {
  const text = err instanceof Error ? err.message : String(err);
  return { line: 1, rule: "render", message: text.slice(0, DRAW_RENDER_MESSAGE_MAX) };
}

export function buildDrawCheck(a: {
  /** Writes the code to the version's file and returns its path (the file every attempt of a version overwrites). */
  scenePathFor: (code: string) => string;
  kitExports: readonly string[];
  typecheck: (scenePath: string) => DrawIssue[];
  /** Bundles and renders the three stills; rejects when the scene throws or runs past the limit. */
  renderStills: (scenePath: string) => Promise<string[]>;
  isBlank: (png: string) => Promise<boolean>;
}): DrawCheck {
  return async (code) => {
    const staticIssues = checkDrawnScene(code, a.kitExports);
    if (staticIssues.length > 0) return staticIssues;

    const scenePath = a.scenePathFor(code);
    const typeIssues = a.typecheck(scenePath);
    if (typeIssues.length > 0) return typeIssues;

    let stills: string[];
    try {
      stills = await a.renderStills(scenePath);
    } catch (err) {
      if (err instanceof DrawSetupError) throw err;
      return [renderIssue(err)];
    }

    // Every still is read, not stopped at the first painted one: three
    // frames is the whole cost, and a decoder that fails on any of them is a
    // fault worth hearing about on this run, not the next.
    const blank = await Promise.all(stills.map((png) => a.isBlank(png)));
    if (blank.length > 0 && blank.every(Boolean)) return [{ line: 1, rule: "render", message: DRAW_BLANK_MESSAGE }];
    return [];
  };
}
