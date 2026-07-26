import type { Production } from "./schema";
import { TimeMap } from "./timemap";

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}

/** Human-readable account of every cut: what, where, why, and how much. */
export function formatCutReport(production: Production): string {
  const cutlist = production.cutlist ?? [];
  const removals = cutlist.filter((s) => s.kind === "remove");
  const map = new TimeMap(cutlist);
  const srcDur = production.source.probe.duration;
  const lines: string[] = [];
  lines.push(`ossclip cut report — cleanup level: ${production.cleanup}`);
  lines.push(`source: ${production.source.path}`);
  lines.push("");
  if (removals.length === 0) {
    lines.push("Nothing removed — the take plays exactly as recorded.");
  } else {
    for (const r of removals) {
      const dur = (r.srcOut - r.srcIn).toFixed(2);
      const conf = r.confidence !== undefined ? ` (conf ${r.confidence.toFixed(2)})` : "";
      lines.push(`  [${fmt(r.srcIn)} → ${fmt(r.srcOut)}]  ${r.reason ?? "?"}  −${dur}s${conf}`);
    }
  }
  const removed = srcDur - map.outputDuration;
  lines.push("");
  lines.push(
    `${removals.length} cut(s) · removed ${removed.toFixed(2)}s of ${srcDur.toFixed(2)}s ` +
      `(${((removed / srcDur) * 100).toFixed(1)}%) · output ${map.outputDuration.toFixed(2)}s`,
  );
  return lines.join("\n");
}
