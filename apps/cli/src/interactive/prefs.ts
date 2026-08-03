import type { OpenEditorPref } from "@ossclip/core";

export type OpenEditorDecision = "open" | "skip" | "ask";

/**
 * Whether a finished produce run opens the editor, asks, or says nothing.
 *
 * Pure so the whole precedence order is tested without a produce run: flags
 * beat the stored preference, the stored preference beats asking, and no TTY
 * means never ask.
 */
export function decideOpenEditor(i: {
  flag: boolean | undefined;
  pref: OpenEditorPref;
  interactive: boolean;
  rendered: boolean;
}): OpenEditorDecision {
  // An explicit flag is a deliberate instruction and wins outright — including
  // over `rendered`, because the editor reads render-props.json, which a
  // --no-render run does write.
  if (i.flag === true) return "open";
  if (i.flag === false) return "skip";
  // Otherwise a run with no render has nothing to look at, so the offer is noise.
  if (!i.rendered) return "skip";
  if (i.pref === "always") return "open";
  if (i.pref === "never") return "skip";
  return i.interactive ? "ask" : "skip";
}
