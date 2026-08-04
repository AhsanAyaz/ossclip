/**
 * The guarded Save the top bar's button and Overlay's ⌘S both route through
 * (PLAN 2026-08-04 fix wave, final review finding 1) — pulled out pure, same
 * reason `renderCompleteReload` (renderStatus.ts) is: testable without
 * mounting `<App>`/`<Player>` in jsdom just to prove a boolean.
 *
 * `produce` writes the src-resolved, re-anchored overrides.json write-back
 * BEFORE the ffmpeg render runs (right after render-props.json), so the
 * exposure window for a mid-render Save is the WHOLE render — minutes, not a
 * sub-second race. A Save that lands in that window PUTs the PRE-render
 * in-memory doc over that write-back, silently erasing `src` and the
 * re-anchored splits/pins produce just computed. The post-render reload
 * (`renderCompleteReload` above) then adopts the clobbered doc with
 * `wasDirty` false — the PUT itself is what cleared it — so nothing tells
 * the user their cut just lost its anchor, and the NEXT produce cuts the
 * wrong range against a `src` that no longer means what it says. The Save
 * button's `disabled={!edits.dirty || render?.running === true}` is
 * belt-and-braces; this is the guard that also covers ⌘S, which has no
 * `disabled` to lean on at all.
 */
export function guardedSave(
  renderRunning: boolean,
  save: () => Promise<void>,
): { blocked: true; reason: string } | { blocked: false; result: Promise<void> } {
  if (renderRunning) {
    return {
      blocked: true,
      reason:
        "Can't save while a render is running — it's writing its own overrides.json " +
        "right now; wait for it to finish (or cancel it) before saving.",
    };
  }
  return { blocked: false, result: save() };
}
