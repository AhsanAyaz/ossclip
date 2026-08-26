import { basename } from "node:path";
import { z } from "zod/v4";
import type {
  PublishPost,
  PublishProvider,
  PublishReceipt,
  PublishRequest,
  PublishTarget,
  PublishWhen,
} from "./provider";

/**
 * The Postiz implementation of `PublishProvider` — a self-hosted Postiz
 * instance (https://github.com/gitroomhq/postiz-app) the USER runs and has
 * connected their social accounts to; ossclip only speaks its public HTTP
 * API (https://docs.postiz.com/public-api) and vendors nothing (Postiz is
 * AGPL; calling an API is not derivation).
 *
 * Contract, per those docs: base `{url}/api/public/v1`, `Authorization:
 * <apiKey>` verbatim (NOT `Bearer <apiKey>`), `POST /upload` (multipart →
 * `{id, path}`), `GET /integrations`, `POST /posts` with
 * `{type, date, posts: [{integration:{id}, value:[{content, image:[...]}],
 * settings:{__type: <provider>}}]}`. Rate limit 90 posts/hr self-hosted.
 *
 * Error posture is the OPPOSITE of telemetry.ts: a publish is the user's
 * explicit action on their own content, so every non-2xx throws with the
 * method, path, status and a body snippet — no retries, no swallowing, no
 * partial state pretending to be success.
 */

/** `GET /integrations` — only the fields ossclip reads; unknown keys drop. */
export const PostizIntegrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The platform identifier ("linkedin", "x", "instagram", ...). */
  identifier: z.string(),
  disabled: z.boolean().optional(),
});
export const PostizIntegrationsSchema = z.array(PostizIntegrationSchema);

/** `POST /upload` — the media reference `/posts` embeds. */
export const PostizUploadSchema = z.object({
  id: z.string(),
  path: z.string(),
});
export type PostizUpload = z.infer<typeof PostizUploadSchema>;

/**
 * Connected accounts → publish targets. Disabled integrations are dropped
 * here, not at selection time — an account Postiz itself won't post to must
 * never appear in a picker.
 */
export function parseIntegrations(json: unknown): PublishTarget[] {
  const parsed = PostizIntegrationsSchema.parse(json);
  return parsed
    .filter((i) => i.disabled !== true)
    .map((i) => ({ id: i.id, provider: i.identifier, name: i.name }));
}

/**
 * `/posts` accepts one request for MANY integrations — one unit against the
 * 90/hr limit, and atomic from ossclip's side. Pure: the caller passes the
 * already-uploaded media ref and the date, so the exact payload is testable
 * (and `--dry-run` printable) without a network or a clock.
 *
 * `settings.__type` must name the integration's platform; beyond that the
 * per-provider settings surface is Postiz's own validation domain — ossclip
 * sends the minimum and surfaces Postiz's errors verbatim rather than
 * duplicating (and drifting from) that matrix. YouTube is the one platform
 * whose settings carry a required title, so a post's `title` passes through.
 */
export function buildPostsPayload(args: {
  posts: PublishPost[];
  when: PublishWhen;
  dateIso: string;
  media: PostizUpload;
}): Record<string, unknown> {
  const image = [{ id: args.media.id, path: args.media.path }];
  return {
    type: args.when.kind === "now" ? "now" : "schedule",
    date: args.when.kind === "at" ? args.when.iso : args.dateIso,
    shortLink: false,
    posts: args.posts.map((p) => ({
      integration: { id: p.target.id },
      value: [{ content: p.caption, image }],
      settings: {
        __type: p.target.provider,
        ...(p.title !== undefined ? { title: p.title } : {}),
      },
    })),
  };
}

/**
 * Post ids out of whatever shape `/posts` answers with. Lenient BY DESIGN,
 * unlike every other parse here: the 2xx status is the success signal, the
 * ids are a convenience for the receipt, and a Postiz version that renames
 * this envelope must not turn an accepted publish into a thrown "failure"
 * after the posts already went out.
 */
export function extractPostIds(json: unknown): string[] {
  const items = Array.isArray(json)
    ? json
    : typeof json === "object" && json !== null && Array.isArray((json as { posts?: unknown }).posts)
      ? ((json as { posts: unknown[] }).posts)
      : [json];
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item === "object" && item !== null) {
      const id = (item as { id?: unknown; postId?: unknown }).id ?? (item as { postId?: unknown }).postId;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/** `postizUrl` as the API base: trailing slashes dropped, `/api/public/v1`
 * appended unless the user already wrote it. */
export function postizApiBase(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/api/public/v1") ? trimmed : `${trimmed}/api/public/v1`;
}

export class PostizHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    bodySnippet: string,
  ) {
    const hint =
      status === 401 || status === 403
        ? " — Postiz rejected the API key (Settings → Public API in your Postiz instance)"
        : status === 413
          ? " — the upload exceeds the Postiz instance's size limit"
          : status === 429
            ? " — Postiz rate limit (90 posts/hour per self-hosted instance)"
            : "";
    super(`Postiz ${method} ${path} failed: ${status}${hint}${bodySnippet ? `\n${bodySnippet}` : ""}`);
    this.name = "PostizHttpError";
  }
}

export interface PostizProviderOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per-request cap. Uploads carry whole videos — default is generous. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const BODY_SNIPPET_CHARS = 300;

export function createPostizProvider(opts: PostizProviderOptions): PublishProvider {
  const base = postizApiBase(opts.baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = async (method: string, path: string, body?: BodyInit, headers?: Record<string, string>): Promise<unknown> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: opts.apiKey, ...headers },
        body,
        signal: ac.signal,
      });
    } catch (err) {
      throw new Error(
        `Postiz ${method} ${path} unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new PostizHttpError(method, path, res.status, text.slice(0, BODY_SNIPPET_CHARS));
    }
    try {
      return text.length > 0 ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Postiz ${method} ${path} answered non-JSON: ${text.slice(0, BODY_SNIPPET_CHARS)}`);
    }
  };

  return {
    name: "postiz",
    async listTargets(): Promise<PublishTarget[]> {
      return parseIntegrations(await request("GET", "/integrations"));
    },
    async publish(req: PublishRequest): Promise<PublishReceipt> {
      // openAsBlob streams the file into multipart form-data without ever
      // holding the whole video in memory — a rendered short is routinely
      // hundreds of MB, and a string/Buffer round-trip would double it.
      const { openAsBlob } = await import("node:fs");
      const blob = await openAsBlob(req.videoPath, { type: "video/mp4" });
      const form = new FormData();
      form.append("file", blob, basename(req.videoPath));
      const media = PostizUploadSchema.parse(await request("POST", "/upload", form));

      const payload = buildPostsPayload({
        posts: req.posts,
        when: req.when,
        dateIso: new Date().toISOString(),
        media,
      });
      let answer: unknown;
      try {
        answer = await request("POST", "/posts", JSON.stringify(payload), {
          "content-type": "application/json",
        });
      } catch (err) {
        // The media is already up — say so, so a retry is one request, not
        // a re-upload of the whole video.
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}\n` +
            `(the video uploaded fine — media id ${media.id}; retrying will re-upload it)`,
        );
      }
      return {
        backend: "postiz",
        postIds: extractPostIds(answer),
        publishedAt: new Date().toISOString(),
        when: req.when,
        targets: req.posts.map((p) => p.target),
      };
    },
  };
}
