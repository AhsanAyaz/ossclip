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
  // Above the stored preference, not below it: a persisted "always" (or
  // OSSCLIP_OPEN_EDITOR=always) is not a per-run instruction, and starting a
  // long-lived edit server in `ossclip produce take.mp4 > build.log 2>&1`
  // holds the event loop open with nobody there to see it or close it. Only
  // the explicit flag above may do that.
  if (!i.interactive) return "skip";
  // Otherwise a run with no render has nothing to look at, so the offer is noise.
  if (!i.rendered) return "skip";
  if (i.pref === "always") return "open";
  if (i.pref === "never") return "skip";
  return "ask";
}

export type OpenEditorAnswer = "yes" | "no" | "always" | "never";

/**
 * What each answer to the end-of-run offer means: whether to open now, and
 * the preference to persist if the answer was one of the two that stop the
 * asking. Pure so all four are asserted without a prompt — the interactive
 * path is then only the I/O around it.
 */
export function answerToDecision(answer: OpenEditorAnswer): {
  pref?: OpenEditorPref;
  open: boolean;
} {
  const open = answer === "yes" || answer === "always";
  if (answer === "always" || answer === "never") return { pref: answer, open };
  return { open };
}
