/**
 * The clip starts the editor's take fill numbers `take-N` from
 * (take-framing-identity P0) — pulled out pure so the memo's choice is
 * testable without mounting `<App>`.
 *
 * Produce's list is the span starts PLUS the output edges of kept cleanup
 * ranges (`produce.ts`'s `takeClipStarts`), and it writes that exact list
 * into render-props. The editor used span starts alone, so once a range was
 * kept or dismissed the same footage carried a different take id in the
 * editor than in the render, and a framing edit made on screen landed on the
 * wrong take there (FE Loop: produce's `take-10` starts at 161.291, a
 * kept-range edge no span starts at).
 *
 * Presence of `takeClipStarts` means an upgraded produce wrote these props
 * (it writes the field always, even with no kept edges); without it — older
 * render-props — the span starts are today's behaviour, unchanged.
 */
export function editorTakeClipStarts(props: {
  spans?: ReadonlyArray<{ outIn: number }>;
  takeClipStarts?: number[];
}): number[] {
  return props.takeClipStarts ?? (props.spans ?? []).map((s) => s.outIn);
}
