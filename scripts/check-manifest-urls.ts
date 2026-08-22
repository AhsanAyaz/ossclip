/**
 * HEAD every URL the setup manifest can hand out, and fail naming any that is
 * gone. `pnpm check:urls`.
 *
 * This exists because of #6 (§145, §146): the ffmpeg pin was a BtbN *daily*
 * autobuild tag, which upstream prunes after ~2 weeks. When it rotated away,
 * `ossclip setup` could not install ffmpeg on ANY platform it provisions for,
 * and the first anyone heard of it was a stranger's bug report.
 *
 * Two things failed to catch it, and this script is the answer to both:
 *
 *  - The unit suite asserts URL *shape* (`^https://github\.com/`), which a
 *    dead link satisfies perfectly. `pnpm test` must stay offline and
 *    deterministic, so the network check cannot live there — it lives here.
 *  - setup-e2e caches ~/.ossclip on the manifest hash, so its weekly cron
 *    restored the cache and never downloaded anything.
 *
 * The whole platform×arch matrix is probed, not just this machine's: the
 * point is that a macOS maintainer bumping a pin learns immediately that the
 * Windows asset 404s (§136).
 */

import { MODELS, ffmpegAsset, modelUrl, whisperAsset } from "../apps/cli/src/setup/manifest";

const MATRIX: ReadonlyArray<readonly [NodeJS.Platform, string]> = [
  ["win32", "x64"],
  ["win32", "arm64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "arm64"],
  ["darwin", "x64"],
];

interface Target {
  label: string;
  url: string;
}

function targets(): Target[] {
  const seen = new Map<string, string>();
  const add = (label: string, url: string) => {
    // The same asset is reachable from several matrix cells (win32/arm64 takes
    // the x64 whisper build); probe each URL once and label it with the first
    // cell that asked for it.
    if (!seen.has(url)) seen.set(url, label);
  };

  for (const [platform, arch] of MATRIX) {
    add(`ffmpeg ${platform}/${arch}`, ffmpegAsset(platform, arch)?.url ?? "");
    add(`whisper ${platform}/${arch}`, whisperAsset(platform, arch)?.url ?? "");
  }
  for (const name of Object.keys(MODELS)) {
    add(`model ${name}`, modelUrl(name));
  }
  seen.delete("");

  return [...seen].map(([url, label]) => ({ label, url }));
}

/**
 * GitHub release assets answer HEAD with a redirect to a signed object store
 * URL, so redirects are followed. A HEAD that upstream rejects outright (405)
 * is retried as a ranged GET for the first byte rather than reported as rot —
 * the question is "does this asset exist", not "does this host like HEAD".
 */
async function probe(url: string): Promise<{ ok: boolean; status: number | string }> {
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (head.status !== 405) return { ok: head.ok, status: head.status };
    const ranged = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
    });
    // Discard the body rather than leaving the socket hanging.
    await ranged.arrayBuffer().catch(() => undefined);
    return { ok: ranged.ok, status: ranged.status };
  } catch (err) {
    return { ok: false, status: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const list = targets();
  console.log(`▸ probing ${list.length} pinned URLs from the setup manifest\n`);

  const results = await Promise.all(
    list.map(async (t) => ({ ...t, ...(await probe(t.url)) })),
  );

  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.label.padEnd(24)} ${r.status}  ${r.url}`);
  }

  const dead = results.filter((r) => !r.ok);
  if (dead.length === 0) {
    console.log(`\n✓ all ${results.length} pinned URLs resolve.`);
    return;
  }

  console.error(`\n✗ ${dead.length} pinned URL(s) are gone:`);
  for (const d of dead) console.error(`  ${d.label} → ${d.status}\n    ${d.url}`);
  console.error(
    "\nRe-pin in apps/cli/src/setup/manifest.ts — and for ffmpeg, pin a BtbN\n" +
      "MONTH-END autobuild tag: the dailies are pruned after ~2 weeks, the last\n" +
      "autobuild of each month is kept indefinitely (§145).",
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
