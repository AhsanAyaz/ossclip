/**
 * The one seam between ossclip and any social-publishing backend, mirroring
 * `producer/provider.ts`: no backend types leak past this interface (the
 * PHASE1 §4 posture, applied to publishing). One implementation today —
 * Postiz (`postiz.ts`) — but the CLI, the edit server and the tests all
 * speak this shape, so a direct per-platform adapter later is a new file,
 * not a rewrite.
 */

/** One connected account at the backend — an "integration" in Postiz terms. */
export interface PublishTarget {
  /** The backend's own id for the connected account. */
  id: string;
  /** The platform identifier the backend reports, e.g. "linkedin", "x". */
  provider: string;
  /** Human-readable account name, for pickers and receipts. */
  name: string;
}

export type PublishWhen = { kind: "now" } | { kind: "at"; iso: string };

export interface PublishPost {
  target: PublishTarget;
  caption: string;
  /**
   * Some platforms carry a title separate from the caption (YouTube).
   * Optional — most don't.
   */
  title?: string;
  /**
   * YouTube's privacy status — REQUIRED by Postiz's own DTO (`type`,
   * @IsDefined), so a YouTube post without it fails validation and takes the
   * whole /posts call with it (2026-08-28). Optional here because only
   * YouTube has the concept; `buildPostsPayload` supplies the default.
   */
  youtubePrivacy?: "public" | "unlisted" | "private";
}

export interface PublishRequest {
  /**
   * Absolute path of the rendered video — the delivery encode, or the master
   * when none is needed (`ensureDeliveryFile`). ONE file for every post:
   * sending the master to YouTube and the delivery encode elsewhere needs
   * per-post media (a `PublishPost` media field, two uploads in
   * `postiz.publish()`, per-post mapping in `buildPostsPayload`) — a deferred
   * follow-up, not this change (2026-08-29 plan).
   */
  videoPath: string;
  posts: PublishPost[];
  when: PublishWhen;
}

/**
 * What `publish()` returns AND what `<workdir>/publish-receipt.json` holds —
 * the double-post guard reads this file, so it records enough to tell the
 * user what already went out, and when.
 */
export interface PublishReceipt {
  backend: string;
  /** Backend post ids, when the backend reports them; may be empty. */
  postIds: string[];
  /** ISO time the publish request was accepted (not the scheduled time). */
  publishedAt: string;
  when: PublishWhen;
  targets: PublishTarget[];
}

export interface PublishProvider {
  readonly name: string;
  listTargets(): Promise<PublishTarget[]>;
  publish(req: PublishRequest): Promise<PublishReceipt>;
}
