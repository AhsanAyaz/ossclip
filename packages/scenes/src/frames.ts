/**
 * `frameWindow` (FINDINGS §115) moved to core for the clip kit (§162): the
 * kit plans each scene clip's length there, and it must be the same window
 * the scene has here. Re-exported so every `./frames` import keeps working;
 * one function, never a copy.
 */
export { frameWindow } from "@ossclip/core/browser";

/**
 * Drop spans whose SOURCE window rounds to zero frames at this fps. Such a
 * span cannot be played — `<OffthreadVideo trimBefore={n} trimAfter={n}>` is
 * a Remotion validation THROW, and inside the Player that error boundary
 * blanks the entire preview and stops playback (the 2026-08-31 ADK crash:
 * a 3-decimal-rounded user cut left a 125µs keep sliver). recut.ts absorbs
 * new slivers at the source; this filter is the defense-in-depth for docs
 * older versions already saved.
 */
export function playableSpans<T extends { srcIn: number; srcOut: number }>(
  spans: readonly T[],
  fps: number,
): T[] {
  return spans.filter((sp) => Math.round(sp.srcOut * fps) > Math.round(sp.srcIn * fps));
}
