import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InvalidArgumentError } from "commander";
import {
  YOUTUBE_APPROVED_BASENAME,
  YoutubePackSchema,
  buildPostsPayload,
  captionForProvider,
  createPostizProvider,
  loadConfig,
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
export function buildPublishPosts(pack: YoutubePack, targets: PublishTarget[]): PublishPost[] {
  return targets.map((target) => ({
    target,
    caption: captionForProvider(pack, target.provider),
    ...(target.provider === "youtube" ? { title: pack.titles[0] } : {}),
  }));
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

  const when: PublishWhen = flags.at ? { kind: "at", iso: flags.at } : { kind: "now" };
  const posts = buildPublishPosts(pack, picked);
  console.log(summarizePosts(posts, when));

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

  console.log(`▸ uploading ${out} to Postiz...`);
  const result = await provider.publish({ videoPath: out, posts, when });
  await writeFile(publishReceiptPath(workdir), `${JSON.stringify(result, null, 2)}\n`);
  const where = configured.baseUrl.replace(/\/+$/, "");
  console.log(
    when.kind === "now"
      ? `✓ published to ${picked.length} account(s)`
      : `✓ scheduled for ${when.iso} on ${picked.length} account(s)`,
  );
  if (result.postIds.length > 0) console.log(`  posts: ${result.postIds.join(", ")}`);
  console.log(`  track it: ${where}/launches`);
}
