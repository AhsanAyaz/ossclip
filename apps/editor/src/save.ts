/**
 * The full Save side-effect — the top bar's button and Overlay's ⌘S both
 * route through this (PLAN 2026-08-04 fix wave, final review finding 1;
 * scoped re-review fixed a regression in the first cut, documented below).
 * Exported as the actual glue `App.tsx`'s `onSave` calls, not a
 * re-implementation of it, so a jsdom test that mounts `Overlay` and
 * dispatches a real ⌘S exercises the SAME code path production does —
 * that wiring-level test is what caught the regression a pure-function
 * test of the render-running check alone could not.
 *
 * `produce` writes the src-resolved, re-anchored overrides.json write-back
 * BEFORE the ffmpeg render runs (right after render-props.json), so the
 * exposure window for a mid-render Save is the WHOLE render — minutes, not
 * a sub-second race. A Save that lands in that window PUTs the PRE-render
 * in-memory doc over that write-back, silently erasing `src` and the
 * re-anchored splits/pins produce just computed. The post-render reload
 * (`renderCompleteReload`, renderStatus.ts) then adopts the clobbered doc
 * with `wasDirty` false — the PUT itself is what cleared it — so nothing
 * tells the user their cut lost its anchor, and the NEXT produce cuts the
 * wrong range against a `src` that no longer means what it says.
 *
 * Two things the first cut of this guard got wrong (scoped re-review,
 * Important — both fixed here):
 *
 * 1. It routed a block through `App.tsx`'s `setError`, which is FATAL —
 *    `error` early-returns the whole app to a full-screen "Couldn't load
 *    the production" view with no dismiss and no state reset. ⌘S during a
 *    multi-minute render — the EXACT habit this guard exists to intercept
 *    — killed the entire editor, and the only way out was a page reload,
 *    which discards the in-memory doc: the guard destroyed the very edits
 *    it was protecting. `onBlocked` below is wired to a dismissible inline
 *    notice instead, the same shape `dirtyDiscardedNotice` already uses;
 *    `onSaveError` stays reserved for an actual failed PUT, which is a
 *    real, recoverable-by-retry error, not a routine "wait for the render".
 * 2. It checked `renderRunning` before `dirty`, so a reflexive ⌘S with
 *    NOTHING to save still surfaced a block. `dirty` is checked first —
 *    a clean doc has nothing to protect, so this silently no-ops.
 */
export function onSaveEffect(args: {
  dirty: boolean;
  renderRunning: boolean;
  save: () => Promise<void>;
  onBlocked: () => void;
  onSaveError: (message: string) => void;
}): void {
  if (!args.dirty) return;
  if (args.renderRunning) {
    args.onBlocked();
    return;
  }
  void args.save().catch((err) =>
    args.onSaveError(err instanceof Error ? err.message : String(err)),
  );
}
