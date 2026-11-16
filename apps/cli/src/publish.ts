import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InvalidArgumentError } from "commander";
import { z } from "zod/v4";
import {
  sizeCapBytesFor,
  YOUTUBE_APPROVED_BASENAME,
  YoutubePackSchema,
  buildPostsPayload,
  captionCap,
  captionForProvider,
  captionLength,
  checkDurationCaps,
  createPostizProvider,
  deliveryEncodePlan,
  encodeEta,
  ensureDeliveryFile,
  formatMinSec,
  loadConfig,
  probe,
  type DeliveryPlan,
  type DurationViolation,
  type OssclipConfig,
  type PublishPost,
  type PublishProvider,
  type PublishReceipt,
  type PublishTarget,
  type PublishWhen,
  type YoutubePack,
} from "@ossclip/core";
import { readRecordedCommand, recordedOutPath } from "./cover";

/**
 * `ossclip publish` — push the finished render to the user's own social
 * accounts through their self-hosted Postiz instance (publish/postiz.ts has
 * the API contract). This file is the CLI orchestration; every decision that
 * can be pure IS pure and exported, so the edit server's /api/publish speaks
 * the same code instead of a second spelling of it.
 *
 * Publishing is ALWAYS an explicit act: the human-review doctrine (README's
 * "review the output before publishing") means nothing here runs at the end
 * of produce, and a workdir that already published refuses to double-post
 * without --force.
 */

/** The double-post guard's file — holds the last `PublishReceipt`. */
export const PUBLISH_RECEIPT_BASENAME = "publish-receipt.json";

export function publishReceiptPath(workdir: string): string {
  return join(workdir, PUBLISH_RECEIPT_BASENAME);
}

/**
 * `--at <iso>` → a validated FUTURE instant (§93a: reject, never coerce — a
 * typo'd date must not schedule a post for 1970 or fire immediately).
 * Exported so the rejection matrix is testable without commander's exit.
 */
export function atFlag(v: string, now: () => number = Date.now): string {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    throw new InvalidArgumentError(
      `--at wants an ISO-8601 time like 2026-09-01T08:00:00+02:00, got "${v}"`,
    );
  }
  if (ms <= now()) {
    throw new InvalidArgumentError(`--at wants a time in the future, got "${v}" (already passed)`);
  }
  return new Date(ms).toISOString();
}

/** `--platforms a,b` → trimmed, lowercased, deduped identifiers. Rejects an
 * empty list; whether an identifier MATCHES anything is checked against the
 * live integrations list, where the error can name what actually exists. */
export function platformsFlag(v: string): string[] {
  const list = [...new Set(v.split(",").map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0))];
  if (list.length === 0) {
    throw new InvalidArgumentError(`--platforms wants a comma-separated list like "linkedin,instagram", got "${v}"`);
  }
  return list;
}

/** `--accounts id1,id2` → trimmed ids (matched against integration ids). */
export function accountsFlag(v: string): string[] {
  const list = v.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (list.length === 0) {
    throw new InvalidArgumentError(`--accounts wants a comma-separated list of integration ids, got "${v}"`);
  }
  return list;
}

/**
 * Postiz configuration, resolved: `postizUrl` from config.json (non-secret),
 * the API key from the environment ONLY (env.ts's rule — secrets never live
 * in config.json). The error names exactly what's missing and where it goes,
 * because "publish isn't configured" without the fix is a support ticket.
 */
export type PublishConfig =
  | { ok: true; baseUrl: string; apiKey: string }
  | { ok: false; message: string };

export const POSTIZ_API_KEY_ENV = "OSSCLIP_POSTIZ_API_KEY";

export function publishConfigured(
  config: Pick<OssclipConfig, "postizUrl">,
  env: NodeJS.ProcessEnv,
): PublishConfig {
  const url = typeof config.postizUrl === "string" ? config.postizUrl.trim() : "";
  const key = env[POSTIZ_API_KEY_ENV]?.trim() ?? "";
  const missing: string[] = [];
  if (url.length === 0) missing.push(`"postizUrl" in ~/.ossclip/config.json (your Postiz instance's URL)`);
  if (key.length === 0) missing.push(`${POSTIZ_API_KEY_ENV} in the environment or ~/.ossclip/.env (Postiz → Settings → Public API)`);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `publish needs a self-hosted Postiz instance (https://postiz.com). Missing: ${missing.join("; ")}.`,
    };
  }
  return { ok: true, baseUrl: url, apiKey: key };
}

/**
 * Which connected accounts this run posts to — the pure selection rules the
 * CLI flags and the editor's checkbox list both compile down to.
 *
 *  - `accounts` picks by integration id, and an unknown id is an ERROR naming
 *    the known ones (a typo must not silently post to fewer places);
 *  - `platforms` filters by provider identifier, and a platform with no
 *    connected account is an ERROR naming what IS connected;
 *  - `all` (or the editor sending explicit ids) takes what's left.
 * An empty result is always an error — "publish to nothing" is never intent.
 */
export function selectTargets(
  targets: PublishTarget[],
  opts: { platforms?: string[]; accounts?: string[]; all?: boolean },
): PublishTarget[] {
  const available = () =>
    targets.map((t) => `  ${t.id}  ${t.provider}  ${t.name}`).join("\n") || "  (none connected)";
  let pool = targets;
  if (opts.platforms) {
    for (const p of opts.platforms) {
      if (!targets.some((t) => t.provider === p)) {
        throw new Error(`no connected ${p} account in Postiz. Connected:\n${available()}`);
      }
    }
    pool = pool.filter((t) => opts.platforms!.includes(t.provider));
  }
  if (opts.accounts) {
    const picked: PublishTarget[] = [];
    for (const id of opts.accounts) {
      const hit = pool.find((t) => t.id === id);
      if (!hit) throw new Error(`no integration with id "${id}". Connected:\n${available()}`);
      picked.push(hit);
    }
    return picked;
  }
  if (opts.all) {
    if (pool.length === 0) throw new Error(`no connected accounts in Postiz. Connected:\n${available()}`);
    return pool;
  }
  return pool;
}

/**
 * Targets → the posts a publish sends: caption per platform from the pack
 * (captionForProvider owns the authored-else-derived rule), and YouTube gets
 * the pack's first title — the one required settings field Postiz won't
 * default.
 */
export function buildPublishPosts(
  pack: YoutubePack,
  targets: PublishTarget[],
  opts: { youtubePrivacy?: YoutubePrivacy } = {},
): PublishPost[] {
  return targets.map((target) => ({
    target,
    caption: captionForProvider(pack, target.provider),
    ...(target.provider === "youtube"
      ? {
          title: pack.titles[0],
          // Undefined here means `buildPostsPayload`'s own safe default
          // (private) — one place decides it, not two (2026-08-28).
          ...(opts.youtubePrivacy !== undefined
            ? { youtubePrivacy: opts.youtubePrivacy }
            : {}),
        }
      : {}),
  }));
}

/** `--youtube-privacy` — the values Postiz's own DTO accepts, nothing else. */
export const YOUTUBE_PRIVACIES = ["public", "unlisted", "private"] as const;
export type YoutubePrivacy = (typeof YOUTUBE_PRIVACIES)[number];

/**
 * `--youtube-privacy <public|unlisted|private>` → a validated choice.
 * Rejected rather than coerced (§93a, the `--clip` idiom): a typo'd
 * `--youtube-privacy pubic` must not silently fall back to a value that
 * publishes to a subscriber list. Exported so the rejection matrix is
 * testable without commander's exit behaviour.
 */
export function youtubePrivacyFlag(v: string): YoutubePrivacy {
  const found = YOUTUBE_PRIVACIES.find((p) => p === v.trim());
  if (found === undefined) {
    throw new InvalidArgumentError(
      `--youtube-privacy wants one of ${YOUTUBE_PRIVACIES.join(", ")}, got "${v}"`,
    );
  }
  return found;
}

/** `--delivery` — what actually uploads (2026-08-29 handoff, item 1). */
export const DELIVERY_MODES = ["auto", "master"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/**
 * `--delivery <auto|master>` → a validated choice, zod-parsed and rejected
 * rather than coerced (§93a): a typo'd `--delivery masterr` silently falling
 * back to `auto` would re-encode the one run where the user explicitly wanted
 * the untouched master. Exported so the rejection matrix is testable without
 * commander's exit behaviour.
 */
export function deliveryFlag(v: string): DeliveryMode {
  const parsed = z.enum(DELIVERY_MODES).safeParse(v.trim());
  if (!parsed.success) {
    throw new InvalidArgumentError(
      `--delivery wants one of ${DELIVERY_MODES.join(", ")}, got "${v}"`,
    );
  }
  return parsed.data;
}

/** Seconds → "5:20" for the duration-cap messages — a cap named in seconds
 * ("video is 320s") makes the user do the platform's arithmetic. Moved to
 * core with the encode-progress work (2026-08-29) so the editor server spells
 * ETAs the same way; re-exported here so callers keep their import. */
export { formatMinSec } from "@ossclip/core";

/**
 * The encode-progress line: `▸ encoding delivery … 42% · ~1:50 left (1.6x)`.
 * ETA and speed drop off rather than print garbage when ffmpeg hasn't said
 * yet (its warm-up block is all N/A). Pure so the wording is pinned by a
 * test; whether it lands as a \r-rewrite or a log line is the TTY shell's
 * call below.
 */
export function encodeProgressLine(
  durationSec: number,
  p: { outTimeSec?: number; speed?: number },
): string {
  const pct =
    durationSec > 0 && p.outTimeSec !== undefined
      ? Math.min(100, Math.floor((p.outTimeSec / durationSec) * 100))
      : 0;
  const eta =
    p.outTimeSec !== undefined && p.speed !== undefined
      ? encodeEta(durationSec, p.outTimeSec, p.speed)
      : null;
  const tail =
    eta !== null ? ` · ~${formatMinSec(eta)} left (${p.speed!.toFixed(1)}x)` : "";
  return `▸ encoding delivery … ${pct}%${tail}`;
}

/**
 * One loud line per refused channel — the platform hard-fails an over-cap
 * upload anyway (the 5:20 take was doomed on Threads' 5:00 cap before a
 * single byte uploaded), so the refusal names the cap instead of letting the
 * platform's opaque error do it. Pure so the wording is pinned by a test.
 */
export function durationCapMessages(violations: DurationViolation[], durationSec: number): string[] {
  return violations.map(
    (v) =>
      `▸ ${v.target.provider} capped at ${formatMinSec(v.capSec)}, video is ` +
      `${formatMinSec(durationSec)} — skipping ${v.target.name}`,
  );
}

/**
 * The surviving targets grouped by their platform's byte ceiling
 * (`PLATFORM_SIZE_CAP_BYTES`) — one delivery encode per distinct cap, not per
 * channel, so two capped accounts on the same platform share one file.
 * Uncapped targets don't appear; they ride the default delivery encode.
 */
export function sizeCapGroups(
  targets: PublishTarget[],
  /** The `postizMaxUploadMb` ceiling in bytes (`postizUploadCapBytes`). */
  uploadCapBytes: number | null = null,
): Map<number, PublishTarget[]> {
  const groups = new Map<number, PublishTarget[]>();
  for (const t of targets) {
    const capBytes = sizeCapBytesFor(t.provider, uploadCapBytes);
    if (capBytes === undefined) continue;
    const group = groups.get(capBytes);
    if (group !== undefined) group.push(t);
    else groups.set(capBytes, [t]);
  }
  return groups;
}

/**
 * One line per post whose caption is over its platform's cap, by the
 * PLATFORM'S count (`captionLength` — Threads counts emoji as UTF-8 bytes).
 * Checked before any encode or upload: Postiz only refuses an over-long post
 * at `/posts`, AFTER the whole video has uploaded (2026-11-13, Threads). Pack
 * captions are trimmed to fit already; this guards text typed or
 * regenerated in the editor panel, which is sent as-is.
 */
export function captionOverCapErrors(posts: readonly PublishPost[]): string[] {
  return posts.flatMap((p) => {
    const n = captionLength(p.target.provider, p.caption);
    const cap = captionCap(p.target.provider);
    return n > cap
      ? [
          `${p.target.provider} (${p.target.name}): caption is ${n} / ${cap}` +
            (p.target.provider === "threads" ? " (Threads counts each emoji and symbol by its UTF-8 bytes)" : "") +
            " — shorten it",
        ]
      : [];
  });
}

/**
 * What still needs a human after a publish, or null: TikTok posts go out as
 * an inbox DRAFT (postiz.ts explains why), so the user has to finish them in
 * the TikTok app. The editor panel restates this (PublishPanel.tsx).
 */
export function publishFollowUpNote(providers: readonly string[]): string | null {
  return providers.includes("tiktok")
    ? "▸ TikTok: the video is a draft in your TikTok app's inbox, with no caption — TikTok's " +
        "inbox uploads don't accept one. Open TikTok, paste the caption below, pick its privacy " +
        "and post it within 24 hours, or it is discarded"
    : null;
}

/**
 * Whether any channel rides the UNCAPPED default delivery file. With an
 * upload cap every channel is capped, and the default encode would be 1-3
 * minutes of x264 nobody uploads (the provider uploads each distinct
 * per-post file only).
 */
export function needsDefaultDelivery(
  targets: PublishTarget[],
  uploadCapBytes: number | null = null,
): boolean {
  return targets.some((t) => sizeCapBytesFor(t.provider, uploadCapBytes) === undefined);
}

const UploadCapMbSchema = z.number().finite().positive();

/**
 * `postizMaxUploadMb` from config.json, parsed — never coerced (CLAUDE.md):
 * a quoted `"95"` or a `0` is one warning and NO cap, not a silently
 * different number. Megabytes are decimal, the unit PLATFORM_SIZE_CAP_BYTES
 * is written in. Set it a little under the proxy's limit (95 for
 * Cloudflare's 100MB): the delivery encode targets the cap with a small
 * mux-overhead margin, not a guarantee.
 */
export function postizUploadCapBytes(raw: unknown): { capBytes: number | null; warning: string | null } {
  if (raw === undefined) return { capBytes: null, warning: null };
  const parsed = UploadCapMbSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      capBytes: null,
      warning:
        `▸ ignoring "postizMaxUploadMb" in ~/.ossclip/config.json: expected a positive number ` +
        `of megabytes (e.g. 95), got ${JSON.stringify(raw)} — uploads are not capped`,
    };
  }
  return { capBytes: Math.round(parsed.data * 1_000_000), warning: null };
}

/**
 * One loud line per refused channel when a platform's size cap cannot be met
 * above the quality floor (delivery.ts: below ~1 Mbps, 1080p h264 is mush the
 * platform would host forever) — same drop-and-continue semantics as the
 * duration caps. The line carries the arithmetic that doomed the channel so
 * the fix (shorten, or publish by hand) is obvious. Pure so the wording is
 * pinned by a test.
 */
export function sizeCapUnattainableMessages(
  group: PublishTarget[],
  capBytes: number,
  fittedKbps: number,
  durationSec: number,
): string[] {
  const capMb = Math.round(capBytes / 1_000_000);
  return group.map(
    (t) =>
      `▸ ${t.provider} needs ≤${capMb}MB but a ${formatMinSec(durationSec)} video fits only ` +
      `~${fittedKbps} kbps — skipping ${t.name}; publish it manually or shorten the cut`,
  );
}

/**
 * The over-cap warning for `--delivery master`: master mode bypasses the
 * encode entirely, INCLUDING the size-capped variant, so a capped platform
 * may get a file its ingest will bounce (Instagram's 2207077). The user
 * explicitly chose master, so this warns loudly and proceeds — the one size
 * decision the user is allowed to overrule. Pure so the wording is pinned.
 */
export function masterOverCapWarning(
  group: PublishTarget[],
  capBytes: number,
  masterBytes: number,
): string {
  const providers = [...new Set(group.map((t) => t.provider))].join(", ");
  return (
    `▸ WARNING: the master is ${Math.round(masterBytes / 1_000_000)}MB, over the ` +
    `${Math.round(capBytes / 1_000_000)}MB ${providers} cap — uploading it anyway (--delivery master)`
  );
}

/**
 * Posts → posts with their per-platform media override set: a size-capped
 * platform carries its own smaller encode (`PublishPost.videoPath`), everyone
 * else rides the request's default. A capped path that EQUALS the default
 * (the fitted bitrate came out at the 10 Mbps target, so both plans named the
 * same file) sets no override — the provider would dedupe the upload anyway,
 * but a redundant override obscures which posts genuinely differ.
 */
export function attachDeliveryMedia(
  posts: PublishPost[],
  defaultPath: string,
  cappedPaths: ReadonlyMap<number, string>,
  uploadCapBytes: number | null = null,
): PublishPost[] {
  return posts.map((p) => {
    const capBytes = sizeCapBytesFor(p.target.provider, uploadCapBytes);
    const path = capBytes !== undefined ? cappedPaths.get(capBytes) : undefined;
    return path !== undefined && path !== defaultPath ? { ...p, videoPath: path } : p;
  });
}

/**
 * What the confirm prompt says will upload — decided BEFORE the "yes" so the
 * user approves the actual file, not a surprise re-encode after it. Pure;
 * the encode itself runs post-confirm.
 */
export function describeUpload(mode: DeliveryMode, plan: DeliveryPlan | null): string {
  if (mode === "master") return "master (--delivery master)";
  return plan === null
    ? "master (already within delivery limits)"
    : `${plan.fileName} (delivery encode, cached in workdir)`;
}

/**
 * The pack this publish reads: the APPROVED file when the editor wrote one
 * (an edited pack is the user's decision), else the provider-keyed cache
 * produce wrote. No pack, no publish — the copy is the pack's job, and a
 * publish that invents captions on the spot would end-run the review gate.
 */
export async function loadPublishPack(workdir: string): Promise<YoutubePack | null> {
  const approved = join(workdir, YOUTUBE_APPROVED_BASENAME);
  const candidates = [approved];
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const caches: Array<{ path: string; mtime: number }> = [];
    for (const name of await readdir(workdir)) {
      if (/^youtube-.+\.json$/.test(name) && name !== YOUTUBE_APPROVED_BASENAME) {
        const path = join(workdir, name);
        caches.push({ path, mtime: (await stat(path)).mtimeMs });
      }
    }
    // Newest cache first — the edit server's currentYoutubePack rule: what
    // the LAST produce generated, not whichever key readdir happens to list.
    caches.sort((a, b) => b.mtime - a.mtime);
    candidates.push(...caches.map((c) => c.path));
  } catch {
    return null;
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      // Cache files wrap the pack ({pack: ...}) in some produce versions;
      // accept both spellings and validate either way.
      const inner =
        typeof raw === "object" && raw !== null && "pack" in (raw as Record<string, unknown>)
          ? (raw as { pack: unknown }).pack
          : raw;
      const parsed = YoutubePackSchema.safeParse(inner);
      if (parsed.success) return parsed.data;
    } catch {
      // unreadable candidate — try the next
    }
  }
  return null;
}

export async function readPublishReceipt(workdir: string): Promise<PublishReceipt | null> {
  const path = publishReceiptPath(workdir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as PublishReceipt;
  } catch {
    return null;
  }
}

/** One line per outgoing post, for the confirm prompt and --dry-run. */
export function summarizePosts(posts: PublishPost[], when: PublishWhen): string {
  const head =
    when.kind === "now" ? "publish NOW" : `schedule for ${when.iso}`;
  const rows = posts.map((p) => {
    const firstLine = p.caption.split("\n")[0] ?? "";
    const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
    return `  ${p.target.provider.padEnd(10)} ${p.target.name.padEnd(20)} ${p.caption.length} chars  "${preview}"`;
  });
  return [`▸ ${head} → ${posts.length} account(s):`, ...rows].join("\n");
}

export interface PublishFlags {
  at?: string;
  platforms?: string[];
  accounts?: string[];
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  /** `--youtube-privacy`; undefined = the payload's safe `private` default. */
  youtubePrivacy?: YoutubePrivacy;
  /** `--delivery`; undefined = `auto` (upload the delivery encode). */
  delivery?: DeliveryMode;
}

/**
 * The command. Everything above is the logic; this is the I/O shell —
 * resolve artifacts, pick targets (interactive when nothing selected them),
 * confirm, publish, write the receipt.
 */
export async function runPublish(
  workdir: string,
  flags: PublishFlags,
  deps: {
    provider?: PublishProvider;
    config?: OssclipConfig;
    env?: NodeJS.ProcessEnv;
    /** The two ffmpeg-family shell-outs, injectable so tests never spawn a
     * binary (the `provider` seam applied to ffprobe/ffmpeg): `probeVideo`
     * feeds the duration caps and the upload summary, `ensureDelivery`
     * builds — or reuses — the cached delivery encode. */
    probeVideo?: typeof probe;
    ensureDelivery?: typeof ensureDeliveryFile;
  } = {},
): Promise<void> {
  const config = deps.config ?? loadConfig();
  const configured = publishConfigured(config, deps.env ?? process.env);
  if (!configured.ok) throw new Error(configured.message);

  const cmd = await readRecordedCommand(workdir);
  const out = cmd ? recordedOutPath(cmd) : null;
  if (out === null || !existsSync(out)) {
    throw new Error(
      `no finished render in ${workdir} — run \`ossclip produce\` (or re-render in the editor) first`,
    );
  }
  const pack = await loadPublishPack(workdir);
  if (pack === null) {
    throw new Error(
      "no YouTube pack in this workdir — publish reads its captions from the pack. " +
        "Run produce with --youtube (or approve a pack in the editor) first",
    );
  }

  const receipt = await readPublishReceipt(workdir);
  if (receipt !== null && flags.force !== true) {
    throw new Error(
      `this workdir already published on ${receipt.publishedAt} to ` +
        `${receipt.targets.map((t) => t.provider).join(", ")} — pass --force to publish again`,
    );
  }

  const provider =
    deps.provider ??
    createPostizProvider({ baseUrl: configured.baseUrl, apiKey: configured.apiKey });
  const targets = await provider.listTargets();

  let picked = selectTargets(targets, {
    platforms: flags.platforms,
    accounts: flags.accounts,
    all: flags.all,
  });
  const nothingExplicit = !flags.accounts && !flags.all;
  if (nothingExplicit) {
    const { isInteractive } = await import("./interactive/tty");
    if (!isInteractive()) {
      throw new Error(
        "no accounts selected — pass --all, --accounts <ids> or --platforms <list>. Connected:\n" +
          targets.map((t) => `  ${t.id}  ${t.provider}  ${t.name}`).join("\n"),
      );
    }
    const { multiselect, unwrap } = await import("./interactive/prompts");
    picked = unwrap(
      await multiselect({
        message: "Publish to which accounts?",
        options: picked.map((t) => ({ value: t, label: `${t.provider} — ${t.name}` })),
        required: true,
      }),
    ) as PublishTarget[];
  }

  // Probe ONCE, before the confirm prompt: the duration caps and the upload
  // summary both need it, and a channel this video can never land on must be
  // refused before the user says yes — not after minutes of x264 (2026-08-29
  // handoff: Threads' 5:00 cap vs a 5:20 take).
  const tools = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath };
  const masterProbe = await (deps.probeVideo ?? probe)(tools, out);
  const violations = checkDurationCaps(picked, masterProbe.duration);
  if (violations.length > 0) {
    for (const line of durationCapMessages(violations, masterProbe.duration)) console.log(line);
    const over = new Set(violations.map((v) => v.target.id));
    picked = picked.filter((t) => !over.has(t.id));
    if (picked.length === 0) {
      throw new Error(
        `every selected channel refuses a ${formatMinSec(masterProbe.duration)} video — ` +
          "nothing to publish (shorten the cut, or pick channels without a duration cap)",
      );
    }
  }
  // The plans are recomputed pure here so the confirm prompt can NAME the
  // files that will upload; ensureDeliveryFile re-derives them (and re-probes,
  // one cheap ffprobe each) after the "yes" to keep its cache logic
  // self-contained.
  const deliveryMode = flags.delivery ?? "auto";
  const masterSizeBytes = (await stat(out)).size;
  const src = {
    width: masterProbe.width,
    height: masterProbe.height,
    fps: masterProbe.fps,
    duration: masterProbe.duration,
    sizeBytes: masterSizeBytes,
  };
  // Size-capped platforms get their own smaller encode (2026-08-29, live:
  // Instagram's URL-fetch ingest bounced the 409MB file with 2207077 twice,
  // then published the same take at 88MB — PLATFORM_SIZE_CAP_BYTES). A cap
  // the video cannot fit above the quality floor drops the channel HERE,
  // before the confirm and before a wasted encode, with the duration caps'
  // drop-and-continue semantics.
  // The ceiling on the route to Postiz itself (a proxy's body limit) — it
  // caps every channel, so it folds into the per-platform grouping below.
  const uploadCap = postizUploadCapBytes(config.postizMaxUploadMb);
  if (uploadCap.warning !== null) console.log(uploadCap.warning);
  const uploadCapBytes = uploadCap.capBytes;
  let capGroups = sizeCapGroups(picked, uploadCapBytes);
  const cappedPlans = new Map<number, DeliveryPlan | null>();
  if (deliveryMode === "auto") {
    for (const [capBytes, group] of capGroups) {
      const capped = deliveryEncodePlan(src, { sizeCapBytes: capBytes });
      if (capped !== null && "unattainable" in capped) {
        for (const line of sizeCapUnattainableMessages(
          group,
          capBytes,
          capped.fittedKbps,
          masterProbe.duration,
        )) {
          console.log(line);
        }
        const over = new Set(group.map((t) => t.id));
        picked = picked.filter((t) => !over.has(t.id));
      } else {
        cappedPlans.set(capBytes, capped);
      }
    }
    if (picked.length === 0) {
      throw new Error(
        `every selected channel's size cap is unattainable for a ` +
          `${formatMinSec(masterProbe.duration)} video — nothing to publish ` +
          "(shorten the cut, or publish it manually)",
      );
    }
    capGroups = sizeCapGroups(picked, uploadCapBytes);
  }
  const plan = deliveryMode === "master" ? null : deliveryEncodePlan(src);
  const defaultNeeded = needsDefaultDelivery(picked, uploadCapBytes);

  const when: PublishWhen = flags.at ? { kind: "at", iso: flags.at } : { kind: "now" };
  const posts = buildPublishPosts(pack, picked, { youtubePrivacy: flags.youtubePrivacy });
  const longCaptions = captionOverCapErrors(posts);
  if (longCaptions.length > 0) throw new Error(longCaptions.join("\n"));
  console.log(summarizePosts(posts, when));
  if (defaultNeeded) console.log(`▸ upload: ${describeUpload(deliveryMode, plan)}`);
  for (const [capBytes, group] of capGroups) {
    const label = [...new Set(group.map((t) => t.provider))].join(", ");
    console.log(
      `▸ upload (${label}): ${describeUpload(deliveryMode, cappedPlans.get(capBytes) ?? null)}`,
    );
    if (deliveryMode === "master" && masterSizeBytes > capBytes) {
      console.log(masterOverCapWarning(group, capBytes, masterSizeBytes));
    }
  }

  if (flags.dryRun === true) {
    const payload = buildPostsPayload({
      posts,
      when,
      dateIso: new Date().toISOString(),
      media: { id: "<uploaded-media-id>", path: "<uploaded-media-path>" },
    });
    console.log(`\n▸ dry run — the exact /posts payload (media uploads first, then this):`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (flags.yes !== true) {
    const { isInteractive } = await import("./interactive/tty");
    if (!isInteractive()) {
      throw new Error("not a TTY — pass --yes to publish without the confirmation prompt");
    }
    const { confirm, unwrap } = await import("./interactive/prompts");
    const go = unwrap(await confirm({ message: "Send it?" }));
    if (go !== true) {
      console.log("▸ publish cancelled — nothing sent");
      return;
    }
  }

  // The encodes run AFTER the confirm — 1–3 minutes of x264 each is a bad
  // price for a "no" — and before the upload, which takes the delivery paths.
  let uploadPath = out;
  const cappedPaths = new Map<number, string>();
  if (deliveryMode === "auto") {
    // Live progress (2026-08-29): a TTY gets one \r-rewritten line; anything
    // else (CI, a pipe) gets a plain line per 10% step — a 5-minute encode at
    // 2 blocks/sec would otherwise write ~600 lines into the log. The state
    // is per encode: the size-capped variant restarts the decile counter, and
    // the onStart line names each file so the two encodes stay
    // distinguishable in the log.
    const isTty = process.stdout.isTTY === true;
    const runEnsure = async (sizeCapBytes?: number): ReturnType<typeof ensureDeliveryFile> => {
      let progressShown = false;
      let lastDecile = -1;
      const ensured = await (deps.ensureDelivery ?? ensureDeliveryFile)(tools, workdir, out, {
        ...(sizeCapBytes !== undefined ? { sizeCapBytes } : {}),
        onStart: (name) => console.log(`▸ encoding delivery file ${name} (cached in workdir)`),
        onProgress: (p) => {
          const line = encodeProgressLine(masterProbe.duration, p);
          if (isTty) {
            progressShown = true;
            process.stdout.write(`\r${line}`);
          } else {
            const decile =
              p.outTimeSec !== undefined && masterProbe.duration > 0
                ? Math.floor((p.outTimeSec / masterProbe.duration) * 10)
                : 0;
            if (decile > lastDecile) {
              lastDecile = decile;
              console.log(line);
            }
          }
        },
      });
      // The \r line never newline-terminated itself — without this the next
      // line would overwrite it mid-sentence.
      if (progressShown) process.stdout.write("\n");
      return ensured;
    };
    // Skipped when every channel is capped (an upload cap caps them all):
    // nobody would upload it, and it costs a full encode.
    if (defaultNeeded) {
      const ensured = await runEnsure();
      uploadPath = ensured.path;
      if (!ensured.encoded && ensured.path !== out) {
        console.log(`▸ delivery file already cached — reusing ${ensured.path}`);
      }
    }
    // Size-capped variants next, sequentially — two ffmpegs racing for cores
    // would slow BOTH encodes down, and the unattainable groups were already
    // dropped above so ensureDeliveryFile's throw cannot fire here.
    for (const capBytes of capGroups.keys()) {
      cappedPaths.set(capBytes, (await runEnsure(capBytes)).path);
    }
  }
  const finalPosts = attachDeliveryMedia(posts, uploadPath, cappedPaths, uploadCapBytes);
  const uploading = [...new Set(finalPosts.map((p) => p.videoPath ?? uploadPath))];
  console.log(`▸ uploading ${uploading.join(", ")} to Postiz...`);
  const result = await provider.publish({
    videoPath: uploadPath,
    posts: finalPosts,
    when,
  });
  await writeFile(publishReceiptPath(workdir), `${JSON.stringify(result, null, 2)}\n`);
  const where = configured.baseUrl.replace(/\/+$/, "");
  console.log(
    when.kind === "now"
      ? `✓ published to ${picked.length} account(s)`
      : `✓ scheduled for ${when.iso} on ${picked.length} account(s)`,
  );
  const followUp = publishFollowUpNote(picked.map((t) => t.provider));
  if (followUp !== null) console.log(followUp);
  // The caption itself, ready to paste — the inbox draft arrives blank.
  const tiktokPost = finalPosts.find((p) => p.target.provider === "tiktok");
  if (tiktokPost !== undefined && tiktokPost.caption.length > 0) {
    console.log(`\n${tiktokPost.caption}\n`);
  }
  if (result.postIds.length > 0) console.log(`  posts: ${result.postIds.join(", ")}`);
  console.log(`  track it: ${where}/launches`);
}
