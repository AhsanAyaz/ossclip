/**
 * Logo finder, step 2, the I/O half (logo-finder spec §Step 2 — fetch
 * candidates): for each flagged name, fetch its official homepage, download
 * the logo images `logo-candidates.ts` ranks from it, keep up to 4 real ones
 * and write them under `<work>/logo-candidates/<id>/`. Best-effort by design:
 * nothing here can fail a produce. A name that yields nothing gets a `note`
 * the chip shows instead.
 *
 * `fetch` is injected and never constructed here: produce passes
 * `createGuardedFetch()`, which refuses private addresses at connect time
 * (the domains were named by an LLM), and tests pass a fake, so no test
 * touches the network.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LibraryAddError,
  LogoSuggestionSchema,
  imageSize,
  sniffImageFormat,
  type ImageFormat,
  type LogoCandidate,
  type LogoFlag,
  type LogoSuggestion,
} from "@ossclip/core";
import { fetchLibraryBytes } from "./library-fetch";
import { extractLogoCandidates, manifestIcons, manifestUrl, withManifestIcons } from "./logo-candidates";

/** The workdir subdirectory candidates live in; `LogoCandidateSchema.file` pins the same prefix. */
export const LOGO_CANDIDATES_DIR = "logo-candidates";

// Budgets, verbatim from the plan's Global Constraints (logo-finder spec §Step 2).
const MAX_CANDIDATES = 4;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The homepage cap. A logo is found in the `<head>` and the header, both
 * near the top, so 2 MB of HTML is far more than needed. The manifest is
 * small JSON and shares the cap.
 */
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Ruling: the tray's 5 is for hand-pasted links; a homepage needs fewer. */
const MAX_REDIRECTS = 3;
/** Raster short side floor: a favicon blown up to overlay size is a blur. */
const MIN_SHORT_SIDE = 64;

export type FindLogoCandidatesOptions = {
  work: string;
  fetch: typeof fetch;
  /** Hard wall clock for the whole step. Default 30 s. */
  budgetMs?: number;
  /** Per request, body included. Default 8 s. */
  perRequestMs?: number;
  /** Sites in parallel. Default 4. */
  concurrency?: number;
  /** Clock seam for the budget, so a test can expire it without waiting. */
  now?: () => number;
};

/** Thrown inside a visit once the budget is gone, so it stops at its next await. */
class Abandoned extends Error {}

type Kept = { bytes: Uint8Array; format: ImageFormat; candidate: Omit<LogoCandidate, "file"> };

/** A visit's result, held in memory until it is committed to disk in one synchronous step. */
type Visit = { note?: string; kept: Kept[] };

/**
 * One `LogoSuggestion` per flag, in flag order. Each parses against
 * `LogoSuggestionSchema`, and the files on disk are exactly the ones its
 * `candidates` list.
 *
 * The 30 s budget is a hard wall clock (controller ruling): the step races
 * against it, and a name still in flight when it fires gets
 * `note: "site timed out"` and no files. That is enforced by when files are
 * written, not by cleaning up after: a visit downloads into memory, and its
 * files are written in ONE synchronous block that first checks the budget.
 * The budget timer cannot fire in the middle of synchronous code, so a name
 * is either fully written before the wall or not written at all, and a
 * visit abandoned at the wall can never write later.
 */
export async function findLogoCandidates(
  flags: readonly LogoFlag[],
  o: FindLogoCandidatesOptions,
): Promise<LogoSuggestion[]> {
  const budgetMs = o.budgetMs ?? 30_000;
  const perRequestMs = o.perRequestMs ?? 8_000;
  const concurrency = Math.max(1, o.concurrency ?? 4);
  const now = o.now ?? Date.now;
  const deadline = now() + budgetMs;
  let wallHit = false;
  const expired = (): boolean => wallHit || now() >= deadline;

  for (const f of flags) {
    // The id becomes a directory name. Task 2 mints it with `suggestionIdFor`,
    // so this never fires; it is here so a `..` can never reach `rmSync`.
    if (!LogoSuggestionSchema.shape.id.safeParse(f.id).success) {
      throw new Error(`logo finder: "${f.id}" is not a suggestion id`);
    }
  }

  const dirOf = (id: string): string => join(o.work, LOGO_CANDIDATES_DIR, id);
  const base = (f: LogoFlag): LogoSuggestion => ({
    id: f.id,
    name: f.name,
    word: f.word,
    ...(f.domain !== undefined ? { domain: f.domain } : {}),
    candidates: [],
  });
  const results: (LogoSuggestion | undefined)[] = flags.map(() => undefined);

  // Removing the dir first, for every name this step answers for, keeps the
  // invariant that the workdir holds no candidate its suggestion does not
  // list, including a stale dir from an older run. Only this id's dir.
  const commit = (i: number, visit: Visit): void => {
    const f = flags[i]!;
    const dir = dirOf(f.id);
    const candidates: LogoCandidate[] = [];
    try {
      rmSync(dir, { recursive: true, force: true });
      if (visit.kept.length > 0) mkdirSync(dir, { recursive: true });
      visit.kept.forEach((k, n) => {
        writeFileSync(join(dir, `${n}.${k.format}`), k.bytes);
        candidates.push({ file: `${LOGO_CANDIDATES_DIR}/${f.id}/${n}.${k.format}`, ...k.candidate });
      });
    } catch {
      // A full disk or an unwritable workdir costs this name's logos, not
      // the produce run: the finder is best-effort and must never reject.
      // A half-written dir is removed so no unlisted file survives.
      removeQuietly(dir);
      results[i] = {
        ...base(f),
        candidates: [],
        // With nothing to write, only the stale-dir removal failed: the
        // visit's own note ("no logo found") is still the true one.
        note: visit.kept.length === 0 && visit.note !== undefined ? visit.note : "could not save the logos",
      };
      return;
    }
    results[i] = {
      ...base(f),
      candidates,
      ...(visit.note !== undefined ? { note: visit.note } : {}),
    };
  };

  const queue: number[] = [];
  flags.forEach((f, i) => {
    if (f.domain === undefined) commit(i, { note: "no official site", kept: [] });
    else queue.push(i);
  });

  const get: Get = (url, maxBytes, extra) =>
    fetchLibraryBytes(url, { fetch: o.fetch, maxBytes, timeoutMs: perRequestMs, maxRedirects: MAX_REDIRECTS, ...extra });
  const checkBudget = (): void => {
    if (expired()) throw new Abandoned();
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length && !expired()) {
      const i = queue[next++]!;
      try {
        const v = await visitSite(flags[i] as LogoFlag & { domain: string }, { get, checkBudget });
        // Synchronous from this check to the last write: see the doc comment.
        if (!expired()) commit(i, v);
      } catch (e) {
        if (!(e instanceof Abandoned)) throw e;
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      wallHit = true;
      resolve();
    }, budgetMs);
  });
  const all = Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  // After the wall wins, an abandoned visit may still settle; it must not
  // surface as an unhandled rejection once this function has returned.
  all.catch(() => {});
  try {
    await Promise.race([all, wall]);
  } finally {
    clearTimeout(timer);
  }
  wallHit = true;

  return flags.map((f, i) => {
    const done = results[i];
    if (done !== undefined) return done;
    // Abandoned: no files, including a stale dir from an older run.
    removeQuietly(dirOf(f.id));
    return { ...base(f), note: "site timed out" };
  });
}

/** `rmSync` that never throws: it runs on paths where a failure must not reject the step. */
function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Nothing more to do; the suggestion lists no files for this dir.
  }
}

type Get = (
  url: string,
  maxBytes: number,
  extra?: { overflow?: "error" | "truncate"; onFinalUrl?: (u: URL) => void },
) => Promise<Uint8Array>;

/**
 * One site: the homepage, its manifest, then candidates in rank order until
 * 4 are kept. A candidate that fails to download, sniff or meet the size
 * floor is skipped silently (controller ruling); only the per-name outcome
 * becomes a note.
 */
async function visitSite(
  f: LogoFlag & { domain: string },
  io: { get: Get; checkBudget: () => void },
): Promise<Visit> {
  // https only, no http fallback (controller ruling): an official site that
  // serves no TLS in 2026 is not one whose logo is worth guessing at.
  const homeUrl = `https://${f.domain}/`;
  // Relative URLs resolve against where the page ended up after redirects
  // (ruling R14): `https://a.test/` → `https://www.a.test/en/` makes
  // `logo.png` mean `https://www.a.test/en/logo.png`.
  let pageUrl = homeUrl;
  let html: string;
  try {
    const bytes = await io.get(homeUrl, PAGE_MAX_BYTES, {
      // Ruling R16: a long page is cut, not refused. The logo is in the head
      // and header, near the top.
      overflow: "truncate",
      onFinalUrl: (u) => {
        pageUrl = u.href;
      },
    });
    html = new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    io.checkBudget();
    return { note: homepageNote(f.domain, e), kept: [] };
  }
  io.checkBudget();

  let urls = extractLogoCandidates(html, pageUrl, f.name);
  const manifest = manifestUrl(html, pageUrl);
  if (manifest !== undefined) {
    try {
      // Icon `src`s are relative to the manifest, so the same R14 rule applies
      // to wherever the manifest itself ended up.
      let manifestAt = manifest;
      const bytes = await io.get(manifest, PAGE_MAX_BYTES, {
        onFinalUrl: (u) => {
          manifestAt = u.href;
        },
      });
      const json: unknown = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      urls = withManifestIcons(urls, manifestIcons(json, manifestAt));
    } catch {
      // A missing or broken manifest costs the manifest's icons, nothing more.
    }
    io.checkBudget();
  }

  const kept: Kept[] = [];
  const seen = new Set<string>();
  for (const c of urls) {
    if (kept.length >= MAX_CANDIDATES) break;
    let bytes: Uint8Array;
    try {
      bytes = await io.get(c.url, IMAGE_MAX_BYTES);
    } catch {
      io.checkBudget();
      continue;
    }
    io.checkBudget();
    // The bytes decide, never the URL or content-type: an HTML error page
    // served at `/logo.png` is refused here (spec §Step 2).
    const format = sniffImageFormat(bytes);
    if (format === null) continue;
    let size: { width: number; height: number } | undefined;
    if (format !== "svg") {
      const s = imageSize(bytes);
      if (s === null || Math.min(s.width, s.height) < MIN_SHORT_SIDE) continue;
      size = s;
    }
    // Dedupe by content: a site often serves one icon at several URLs.
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    kept.push({ bytes, format, candidate: { source: c.source, ...(size ?? {}) } });
  }
  return kept.length > 0 ? { kept } : { note: "no logo found", kept };
}

/**
 * The note for a homepage that did not answer with a page: one of a fixed
 * set, never the raw error text (ruling R15), because the note is stored in
 * production.json and shown on the chip, and a remote or OS error string is
 * neither stable nor the author's business. It reads the error's typed
 * `kind`, never its wording, which the tray owns.
 *
 * The domain is the one the flag gave, not the host a redirect reached,
 * because it is what the author sees on the chip.
 */
export function homepageNote(domain: string, e: unknown): string {
  if (e instanceof LibraryAddError) {
    if (e.kind === "timeout") return "site timed out";
    if (e.kind === "status" && e.status !== undefined) return `${domain} answered ${e.status}`;
  }
  return `could not reach ${domain}`;
}
