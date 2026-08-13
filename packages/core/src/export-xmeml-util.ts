/**
 * Shared xmeml plumbing (§142): the marker export (export-premiere-xml.ts)
 * and the pre-cut project export (export-premiere-project.ts) both emit the
 * legacy FCP7 dialect, and its rate mapping and escaping rules must not be
 * allowed to drift apart — a "30 TRUE" that one exporter renders as "29.97"
 * would import a sequence that slips a frame a minute.
 */

/**
 * xmeml has no rational time: a rate is an integer `timebase` plus an `ntsc`
 * flag, and every position is a frame count at that timebase. 29.97 is
 * "30 TRUE" — the flag, not the number, is where the 1001 lives.
 */
export function xmemlRate(fps: number): { timebase: number; ntsc: boolean } {
  const rounded = Math.round(fps);
  // The NTSC family sits ~0.1% under its integer; a probe float lands close
  // to the exact rational, never on the integer itself.
  const ntsc = Math.abs(fps - rounded) > 0.001;
  return { timebase: ntsc ? Math.ceil(fps) : rounded, ntsc };
}

/** The `<rate>` block both exporters emit, at the caller's indentation. */
export function xmemlRateXml(indent: string, timebase: number, ntsc: boolean): string {
  return (
    `${indent}<rate>\n` +
    `${indent}  <timebase>${timebase}</timebase>\n` +
    `${indent}  <ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc>\n` +
    `${indent}</rate>`
  );
}

export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
