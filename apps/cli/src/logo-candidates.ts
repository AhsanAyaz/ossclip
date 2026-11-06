/**
 * Logo finder, step 2, the pure half (logo-finder spec §Step 2 — fetch
 * candidates): a homepage's HTML in, ranked candidate image URLs out. No
 * network and no fs, so the ranking is tested against hand-written fixture
 * pages; `logo-finder.ts` does the fetching.
 *
 * A careful hand scanner rather than a parser dependency (spec "Left to the
 * builder"; plan Global Constraints: no new npm dependency). It reads START
 * tags only, plus the `</header>`/`</nav>` end tags it needs to know whether
 * an `<img>` sits in the page header. It never builds a tree, so broken
 * markup costs a candidate, not the run.
 *
 * Not used (spec §Step 2, "Not used"):
 * - inline `<svg>`: it takes its colour from page CSS, so saved alone it often
 *   renders black or invisible. Nothing inside an `<svg>` is read.
 * - `/favicon.ico`: ICO is not a library format and most are under the 64 px
 *   floor. A declared `.ico` icon link is dropped for the same reason, rather
 *   than downloaded only for the sniffer to refuse it.
 */
import { z } from "zod/v4";

export type CandidateSource = "header" | "icon" | "manifest" | "og";
export type CandidateUrl = { url: string; source: CandidateSource };

type StartTag = { name: string; attrs: Map<string, string>; inHeader: boolean };

/**
 * Elements whose content is text, not markup: a `<header><img class=logo>`
 * inside a `<script>` string must not count as the page's header.
 */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

/** Every start tag in document order, each marked with whether a `<header>` or `<nav>` encloses it. */
function startTags(html: string): StartTag[] {
  const tags: StartTag[] = [];
  const lower = html.toLowerCase();
  let depth = 0;
  let inSvg = 0;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const close = html[lt + 1] === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(lt + (close ? 2 : 1), lt + (close ? 2 : 1) + 64));
    if (!nameMatch) {
      // `<!doctype`, `<?xml`, or a stray `<` in text.
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const { attrs, end, selfClosing } = readAttributes(html, lt + (close ? 2 : 1) + nameMatch[0].length);
    i = end;
    if (close) {
      if ((name === "header" || name === "nav") && depth > 0) depth--;
      if (name === "svg" && inSvg > 0) inSvg--;
      continue;
    }
    if (name === "svg") {
      if (!selfClosing) inSvg++;
      continue;
    }
    if (inSvg > 0) continue;
    tags.push({ name, attrs, inHeader: depth > 0 });
    if ((name === "header" || name === "nav") && !selfClosing) depth++;
    if (RAW_TEXT.has(name)) {
      const endTag = lower.indexOf(`</${name}`, i);
      i = endTag === -1 ? n : endTag;
    }
  }
  return tags;
}

/**
 * Attributes from just after the tag name to the closing `>`. Quotes are
 * honoured, so `alt="a > b"` does not end the tag early.
 */
function readAttributes(html: string, from: number): { attrs: Map<string, string>; end: number; selfClosing: boolean } {
  const attrs = new Map<string, string>();
  const n = html.length;
  let i = from;
  let selfClosing = false;
  const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  while (i < n) {
    while (i < n && isSpace(html[i])) i++;
    if (i >= n) break;
    if (html[i] === ">") return { attrs, end: i + 1, selfClosing };
    if (html[i] === "/") {
      selfClosing = html[i + 1] === ">";
      i++;
      continue;
    }
    const nameStart = i;
    while (i < n && !isSpace(html[i]) && html[i] !== "=" && html[i] !== ">" && html[i] !== "/") i++;
    const attr = html.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(html[i])) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && isSpace(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const endQ = html.indexOf(q, i + 1);
        value = html.slice(i + 1, endQ === -1 ? n : endQ);
        i = endQ === -1 ? n : endQ + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(html[i]) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    if (attr !== "" && !attrs.has(attr)) attrs.set(attr, decodeEntities(value));
    selfClosing = false;
  }
  return { attrs, end: n, selfClosing };
}

/** The entities that show up in real `href`/`src` values; anything else stays as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|apos|lt|gt|#39|#x27);/gi, (_m, e: string) => {
    switch (e.toLowerCase()) {
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "lt":
        return "<";
      case "gt":
        return ">";
      default:
        return "'";
    }
  });
}

/** `raw` resolved against `base`, http(s) only, without its `#fragment`; undefined otherwise. */
function resolveHttp(raw: string | undefined, base: string): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return undefined;
  }
  // `data:` would skip the download caps and `javascript:` is not an image;
  // only the web is a candidate, the same rule `fetchLibraryBytes` applies.
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  u.hash = "";
  return u.href;
}

const isIco = (url: string): boolean => new URL(url).pathname.toLowerCase().endsWith(".ico");

/**
 * The rank of an icon by its declared size: the largest side of its
 * `sizes`, and SVG (by type, `sizes="any"`, or a `.svg` path) as the
 * largest, because it scales to any overlay size. Undeclared is 0.
 */
function iconRank(url: string, sizes: string | undefined, type: string | undefined): number {
  if (type?.toLowerCase().includes("svg") || new URL(url).pathname.toLowerCase().endsWith(".svg")) return Infinity;
  let best = 0;
  for (const token of (sizes ?? "").toLowerCase().split(/\s+/)) {
    if (token === "any") return Infinity;
    const m = /^(\d+)x(\d+)$/.exec(token);
    if (m) best = Math.max(best, Number(m[1]), Number(m[2]));
  }
  return best;
}

/** Ranked largest first; `sort` is stable, so equal ranks keep document order. */
const byRank = (items: { url: string; rank: number }[]): string[] =>
  [...items].sort((a, b) => b.rank - a.rank).map((x) => x.url);

const relTokens = (tag: StartTag): string[] => (tag.attrs.get("rel") ?? "").toLowerCase().split(/\s+/);

/**
 * Candidate image URLs for `name` from its homepage, in the spec's order
 * (logo-finder spec §Step 2):
 *
 * 1. `header` — an `<img>` inside `<header>`/`<nav>` whose `class`, `id`,
 *    `alt`, `aria-label` or `src` contains "logo" or the name.
 * 2. `icon` — `apple-touch-icon` and `icon` links, largest declared size
 *    first, SVG counting as largest.
 * 3. `manifest` — not here: the manifest is a second fetch. `manifestUrl`
 *    names it, and `withManifestIcons` slots its icons in before `og`.
 * 4. `og` — `og:image`, last because it is usually a banner, not a logo.
 *
 * Resolved against `pageUrl`, http(s) only, deduped by URL (first rank wins).
 */
export function extractLogoCandidates(html: string, pageUrl: string, name: string): CandidateUrl[] {
  const tags = startTags(html);
  const needle = name.toLowerCase();
  const header: string[] = [];
  const icons: { url: string; rank: number }[] = [];
  const og: string[] = [];

  for (const tag of tags) {
    if (tag.name === "img" && tag.inHeader) {
      const url = resolveHttp(tag.attrs.get("src"), pageUrl);
      if (url === undefined) continue;
      const said = ["class", "id", "alt", "aria-label", "src"]
        .map((a) => (tag.attrs.get(a) ?? "").toLowerCase())
        .some((v) => v.includes("logo") || (needle !== "" && v.includes(needle)));
      if (said) header.push(url);
    } else if (tag.name === "link") {
      const rel = relTokens(tag);
      if (!rel.some((r) => r === "icon" || r.startsWith("apple-touch-icon"))) continue;
      const url = resolveHttp(tag.attrs.get("href"), pageUrl);
      if (url === undefined || isIco(url)) continue;
      icons.push({ url, rank: iconRank(url, tag.attrs.get("sizes"), tag.attrs.get("type")) });
    } else if (tag.name === "meta") {
      const key = (tag.attrs.get("property") ?? tag.attrs.get("name") ?? "").toLowerCase();
      if (key !== "og:image") continue;
      const url = resolveHttp(tag.attrs.get("content"), pageUrl);
      if (url !== undefined) og.push(url);
    }
  }

  return dedupe([
    ...header.map((url) => ({ url, source: "header" as const })),
    ...byRank(icons).map((url) => ({ url, source: "icon" as const })),
    ...og.map((url) => ({ url, source: "og" as const })),
  ]);
}

function dedupe(list: CandidateUrl[]): CandidateUrl[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

/** The page's `<link rel="manifest">`, resolved and http(s) only, if it has one. */
export function manifestUrl(html: string, pageUrl: string): string | undefined {
  for (const tag of startTags(html)) {
    if (tag.name === "link" && relTokens(tag).includes("manifest")) {
      const url = resolveHttp(tag.attrs.get("href"), pageUrl);
      if (url !== undefined) return url;
    }
  }
  return undefined;
}

/**
 * The manifest is remote JSON, so it is parsed with zod, never cast. Icons
 * are parsed one at a time so one malformed entry costs that icon, not the
 * manifest.
 */
const ManifestSchema = z.object({ icons: z.array(z.unknown()) });
const ManifestIconSchema = z.object({ src: z.string(), sizes: z.string().optional(), type: z.string().optional() });

/** A web app manifest's icon URLs, largest first (SVG largest), resolved against `manifestUrl`. */
export function manifestIcons(json: unknown, manifestUrl: string): string[] {
  const manifest = ManifestSchema.safeParse(json);
  if (!manifest.success) return [];
  const icons: { url: string; rank: number }[] = [];
  for (const raw of manifest.data.icons) {
    const icon = ManifestIconSchema.safeParse(raw);
    if (!icon.success) continue;
    const url = resolveHttp(icon.data.src, manifestUrl);
    if (url === undefined || isIco(url)) continue;
    icons.push({ url, rank: iconRank(url, icon.data.sizes, icon.data.type) });
  }
  return [...new Set(byRank(icons))];
}

/** `fromPage` with the manifest's icons inserted before `og:image` (spec order 3 before 4), deduped. */
export function withManifestIcons(fromPage: CandidateUrl[], icons: string[]): CandidateUrl[] {
  const firstOg = fromPage.findIndex((c) => c.source === "og");
  const at = firstOg === -1 ? fromPage.length : firstOg;
  return dedupe([
    ...fromPage.slice(0, at),
    ...icons.map((url) => ({ url, source: "manifest" as const })),
    ...fromPage.slice(at),
  ]);
}
