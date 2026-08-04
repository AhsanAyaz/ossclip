import type { OverrideDoc } from "@ossclip/core/browser";

/**
 * Parsers for the render log stream (R13). The replayed `produce` already
 * prints everything the panel wants to surface — progress steps, the
 * provider, the token/cost summary — into the same stdout the server
 * ring-buffers. These pick those lines out; nothing here invents data the
 * pipeline didn't report.
 */

/**
 * The latest render progress percentage in the log, or null before the
 * render phase starts printing its `NN%` steps (ingest/produce phases print
 * `▸` lines, not percentages — the panel shows the spinner alone there).
 */
export function renderProgress(lines: readonly string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*(\d{1,3})%\s*$/.exec(lines[i]!);
    if (m) return Math.min(100, Number(m[1]));
  }
  return null;
}

/**
 * Provider and cost lines worth pinning above the scrolling tail: the latest
 * `▸ producing scenes (<provider>)…` and the latest `▸ llm: …` summary
 * (calls · tokens · cost — `formatUsageLine`'s output). Pinned because they
 * scroll out of the 6-line tail long before the render finishes, and they
 * answer exactly what the log otherwise buries: which provider ran and what
 * it cost. Only ever lines the run actually printed — a fully cached
 * re-render makes no LLM calls, and gets no fabricated cost line.
 */
export function pinnedInfoLines(lines: readonly string[]): string[] {
  const latest = (re: RegExp): string | undefined => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (re.test(lines[i]!)) return lines[i]!;
    }
    return undefined;
  };
  return [latest(/^▸ producing scenes/), latest(/^▸ llm:/)].filter(
    (l): l is string => l !== undefined,
  );
}

/** Elapsed `m:ss` between two epoch-ms stamps, floored at zero. */
export function formatElapsed(startedAtMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * What a completed Render's `/api/production` response should do to the
 * editor's in-memory edit doc (PLAN 2026-08-04 Task 4c fix wave, review
 * finding 2) — pulled out as a pure decision so it's testable without
 * mounting `<App>`/`<Player>` in jsdom, which `scene-layer-structure.test.ts`
 * already established as slow and beside the point for this codebase.
 *
 * A successful Render replays `produce`, which — when the doc had cuts —
 * resolves `src` and re-anchors splits/pins against the frame IT just wrote
 * (Task 4b). Left alone, the editor's in-memory doc is still the PRE-render
 * one; the next Save would PUT that stale doc back over produce's own
 * write-back, silently reverting it, and the NEXT produce run after that
 * would re-resolve the cut against the wrong frame and remove a second,
 * wrong range (Task 4b's own Bug B, reintroduced by a different route).
 *
 * Decided resolution: produce's on-disk truth always wins, unconditionally —
 * no field-level merge. `wasDirty` (whether the caller had unsaved local
 * edits at the moment the render finished — `onRender` always saves BEFORE
 * starting, so dirty-at-completion means something changed WHILE it ran)
 * decides only whether to say so; it never blocks the load.
 */
export function renderCompleteReload(
  overrides: OverrideDoc | undefined,
  wasDirty: boolean,
): { load: OverrideDoc | null; notifyDiscard: boolean } {
  if (!overrides) return { load: null, notifyDiscard: false };
  return { load: overrides, notifyDiscard: wasDirty };
}
