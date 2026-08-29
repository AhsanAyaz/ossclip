import React, { useCallback, useEffect, useState } from "react";
import { groupByNetwork } from "./publishGroups";

/**
 * The publish panel (2026-08-26): pick connected accounts, tweak the
 * per-platform captions, and push the finished render through the user's own
 * self-hosted Postiz instance — now or scheduled. Like the YouTube panel,
 * NOT wired through useEdits/overrides: the server owns all the state
 * (/api/publish GET/POST in edit.ts), the panel is fetch-on-open and
 * explicit-button-press only. The Postiz API key never reaches this code —
 * the server does the upload from its own environment.
 *
 * Caption edits here are per-SEND overrides, not writes to the pack: the
 * durable copy lives in the SEO panel's approval file, and a last-second
 * tweak before sending is a different act from editing the pack.
 */

export interface PublishIntegrationInfo {
  id: string;
  provider: string;
  name: string;
  /** The caption the publish WOULD use (authored-else-derived, server-side). */
  caption: string;
  /** The platform's video duration cap in seconds; null/absent = no cap
   * (core's PLATFORM_DURATION_CAPS_SEC, resolved server-side). */
  durationCapSec?: number | null;
}

export interface PublishReceiptInfo {
  backend: string;
  postIds: string[];
  publishedAt: string;
  when: { kind: "now" } | { kind: "at"; iso: string };
  targets: Array<{ id: string; provider: string; name: string }>;
}

export interface PublishInfo {
  configured: boolean;
  reachable?: boolean;
  reason?: string;
  integrations?: PublishIntegrationInfo[];
  packAvailable?: boolean;
  outPathExists?: boolean;
  /** The finished render's duration in seconds; null when the server could
   * not probe it (the panel then skips the pre-flight gray-out — the server
   * still refuses over-cap channels on POST). */
  durationSec?: number | null;
  receipt?: PublishReceiptInfo | null;
}

/**
 * Platform caption caps, hardcoded to match core's CAPTION_CAPS — the
 * YoutubePanel schema-bounds posture: importing core would drag node
 * built-ins into the Vite bundle, and the server re-caps regardless, so
 * drift costs a stale counter, never an over-long post.
 */
export const PANEL_CAPTION_CAPS: Record<string, number> = {
  x: 280,
  linkedin: 1500,
  instagram: 2200,
  tiktok: 2200,
  facebook: 2200,
  youtube: 5000,
};

export function panelCaptionCap(provider: string): number {
  return PANEL_CAPTION_CAPS[provider] ?? 1500;
}

/**
 * YouTube's privacy statuses, hardcoded to match the CLI's YOUTUBE_PRIVACIES
 * (`--youtube-privacy`) for the PANEL_CAPTION_CAPS reason — importing the CLI
 * would drag node built-ins into the Vite bundle. The server re-parses this
 * with zod against its own list, so drift costs a 400, never a wrong privacy.
 * Ordered private-first: it is both the default and the safe one.
 */
export const PANEL_YOUTUBE_PRIVACIES = ["private", "unlisted", "public"] as const;
export type PanelYoutubePrivacy = (typeof PANEL_YOUTUBE_PRIVACIES)[number];

/**
 * The one-line consequence shown under the selector, or null when there is
 * nothing to warn about. Public is the only status that reaches an audience
 * the moment the post lands, and the safe default (postiz.ts's own comment:
 * `type: p.youtubePrivacy ?? "private"`) is only a real safety if choosing
 * past it is deliberate — so the panel says what "public" means rather than
 * offering it silently. Pure so the matrix is testable without a mount.
 */
export function youtubePrivacyNote(privacy: PanelYoutubePrivacy): string | null {
  return privacy === "public"
    ? "Public goes live immediately and straight to subscribers' feeds."
    : null;
}

/** The plain sentences the panel's blocked states show instead of controls. */
export const NOT_CONFIGURED_MESSAGE =
  "Publishing goes through your own self-hosted Postiz instance (postiz.com): set " +
  '"postizUrl" in ~/.ossclip/config.json and OSSCLIP_POSTIZ_API_KEY in ~/.ossclip/.env, ' +
  "then restart the editor.";
export const NO_PACK_MESSAGE =
  "No captions to post yet — run produce with --youtube (or approve a pack in the SEO " +
  "panel) so publish has copy to send.";
export const NO_RENDER_MESSAGE = "No finished render to publish — render first.";

/** Seconds → "5:20" — mirrors the CLI's formatMinSec, hardcoded for the same
 * reason as PANEL_CAPTION_CAPS (importing the CLI would drag node built-ins
 * into the Vite bundle). */
export function formatMinSec(sec: number): string {
  const whole = Math.round(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** GET /api/publish/progress's payload — where the in-flight POST is
 * (edit.ts keeps it current from the encode's ffmpeg progress stream). */
export interface PublishProgressInfo {
  phase: "encoding" | "uploading";
  pct: number | null;
  etaSec: number | null;
  speed: number | null;
  /** The delivery file being encoded — a size-capped publish runs two
   * sequential encodes, so pct restarts mid-publish and only the file name
   * says why. Optional: an older server omits it. */
  file?: string | null;
}

/**
 * What the busy button (and the progress line) says: live percent + ETA
 * while the delivery encode runs, "Uploading…" once it hands off, and the
 * old static line whenever the server has nothing — a cache hit or a
 * skip-plan publish never enters the encoding phase, and a poll that hasn't
 * answered yet must not look like one that failed. Pure so the matrix is
 * testable without a mount.
 */
export function publishBusyLabel(progress: PublishProgressInfo | null): string {
  if (progress === null) return "Encoding & publishing…";
  if (progress.phase === "uploading") return "Uploading…";
  const pct = progress.pct !== null ? `${progress.pct}%` : "…";
  const eta = progress.etaSec !== null ? ` · ~${formatMinSec(progress.etaSec)} left` : "";
  // Name the file when the server says which one — a size-capped publish
  // encodes two, and a percent that resets to 0 mid-publish reads as a hang
  // without the name explaining the restart.
  const file = progress.file != null ? ` ${progress.file}` : "";
  return `Encoding${file} ${pct}${eta}`;
}

/**
 * The chip's over-cap annotation, or null when the channel can take the
 * video. Unknown duration or an uncapped platform is null too — a gray-out
 * on a guess would block a publish the server would have accepted. Pure so
 * the matrix is testable without a mount.
 */
export function overCapNote(
  durationSec: number | null | undefined,
  capSec: number | null | undefined,
): string | null {
  if (typeof durationSec !== "number" || typeof capSec !== "number") return null;
  // Strictly over — a video exactly at the cap is what the cap permits.
  if (durationSec <= capSec) return null;
  return `video ${formatMinSec(durationSec)} > ${formatMinSec(capSec)} cap`;
}

/**
 * The collapsed advisory line above the grounding-note list. One regenerate
 * produced ~45 `⚠ grounding: …` lines and drowned the panel (2026-08-29
 * screenshot) — the COUNT is the signal, the list is on demand. Pure so the
 * singular/plural matrix is testable without a mount.
 */
export function regenNotesSummary(count: number): string {
  return `⚠ ${count} word${count === 1 ? "" : "s"} not in the take`;
}

/** `<input type="datetime-local">`'s value → the ISO the server validates.
 * Pure so the empty/garbage matrix is testable without a mount. */
export function scheduleIso(local: string): string | null {
  if (local.trim().length === 0) return null;
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * `<input type="datetime-local">` wants LOCAL wall-clock text, not an ISO
 * string — `toISOString()` here would silently shift the user's slot by their
 * UTC offset. Built from the local getters for that reason.
 */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** The two slots worth one click; the picker covers everything else. */
export const SCHEDULE_PRESETS: Array<{ label: string; at: (now: Date) => string }> = [
  { label: "In an hour", at: (now) => toLocalInputValue(new Date(now.getTime() + 3600_000)) },
  {
    label: "Tomorrow 9am",
    at: (now) => {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return toLocalInputValue(d);
    },
  },
];

export interface PublishPanelProps {
  onClose: () => void;
}

export const PublishPanel: React.FC<PublishPanelProps> = ({ onClose }) => {
  const [info, setInfo] = useState<PublishInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [scheduleLocal, setScheduleLocal] = useState("");
  // YouTube's privacy for THIS publish, always starting at private
  // (2026-08-29). Deliberately not persisted anywhere — not the pack, not the
  // workdir, not localStorage: postiz.ts defaults an absent privacy to
  // private precisely because publishing to a subscriber list must be an act,
  // and a remembered "public" would turn the next publish into one nobody
  // chose. Every open of this modal asks again.
  const [youtubePrivacy, setYoutubePrivacy] = useState<PanelYoutubePrivacy>("private");
  const scheduleRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // Where the in-flight POST is — fed by the poll onPublish starts, null
  // between publishes (and when the server reports nothing, e.g. a cached
  // delivery file skipping the encode entirely).
  const [progress, setProgress] = useState<PublishProgressInfo | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<PublishReceiptInfo | null>(null);
  // Caption regenerate (2026-08-29, handoff item 4): a per-network
  // instruction box + button beside the caption. The server calls the run's
  // own LLM; the result lands in the caption STATE only — nothing auto-sends,
  // the user still reviews and presses Publish.
  const [regenInstruction, setRegenInstruction] = useState<Record<string, string>>({});
  // The network whose regenerate is in flight, or null. One at a time — the
  // server 409s a second anyway (its call costs money), so every button
  // disables while any runs.
  const [regenBusy, setRegenBusy] = useState<string | null>(null);
  const [regenResult, setRegenResult] = useState<
    Record<string, { usage?: string; notes?: string[]; error?: string }>
  >({});
  // Grounding-note lists start COLLAPSED behind their count (2026-08-29):
  // one regenerate produced ~45 advisory lines — common paraphrase words —
  // and drowned the panel. Errors never collapse: they're actionable.
  const [notesOpen, setNotesOpen] = useState<Record<string, boolean>>({});
  // One instruction for every selected network (2026-08-29): regenerating
  // six captions one by one was the tedium the feedback named. The batch
  // runs SEQUENTIALLY — the server's regenerate is global single-flight and
  // 409s a concurrent call.
  const [batchInstruction, setBatchInstruction] = useState("");
  const [batchProgress, setBatchProgress] = useState<{
    network: string;
    index: number;
    total: number;
  } | null>(null);
  // On-demand pack generation (2026-08-29): a render produced without
  // --youtube has no captions, and this modal dead-ended on "run produce
  // with --youtube" — a full re-produce just to buy one LLM call. The server
  // writes the cache file produce would have (never the approved one), and
  // the refetch is what fills the caption boxes.
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genUsage, setGenUsage] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/publish");
      const body = (await res.json()) as PublishInfo & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `GET /api/publish failed: ${res.status}`);
      setInfo(body);
      if (body.integrations) {
        setCaptions(Object.fromEntries(body.integrations.map((i) => [i.id, i.caption])));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pickedIds = Object.entries(selected)
    .filter(([, on]) => on)
    .map(([id]) => id);
  // Per-channel duration cap, looked up by id at chip-render time — grouping
  // (publishGroups.ts) stays presentation-only and cap-unaware.
  const capById: Record<string, number | null> = Object.fromEntries(
    (info?.integrations ?? []).map((i) => [i.id, i.durationCapSec ?? null]),
  );
  // Grouped once HERE so the batch handler and the JSX walk the SAME list —
  // the batch must target exactly the groups the panel shows.
  const groups = groupByNetwork(
    (info?.integrations ?? []).map((i) => ({ ...i, caption: captions[i.id] ?? i.caption })),
  );
  // Whether the privacy choice is even about anything: no YouTube channel
  // picked means no YouTube post, and the field stays off the request rather
  // than riding along as a setting for platforms that have no such concept.
  const youtubePicked = (info?.integrations ?? []).some(
    (i) => i.provider === "youtube" && selected[i.id] === true,
  );
  const schedule = scheduleIso(scheduleLocal);
  const scheduleInvalid = scheduleLocal.trim().length > 0 && schedule === null;
  const hasReceipt = (info?.receipt ?? null) !== null || sent !== null;

  const onPublish = async (): Promise<void> => {
    setBusy(true);
    setSendError(null);
    // Poll the encode's progress while the POST is in flight (2026-08-29):
    // the server runs the delivery encode synchronously behind this one
    // fetch, so this side-channel is the only live feedback. First tick
    // fires immediately — a 1s blank stare before the first number would
    // read as a hang. Poll errors are swallowed: the POST's own error
    // handling is the loud path, a missed sample is not.
    const tick = (): void => {
      void fetch("/api/publish/progress")
        .then((res) => res.json() as Promise<{ progress?: PublishProgressInfo | null }>)
        .then((body) => setProgress(body.progress ?? null))
        .catch(() => {});
    };
    tick();
    const poll = window.setInterval(tick, 1000);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationIds: pickedIds,
          ...(schedule !== null ? { at: schedule } : {}),
          captions: Object.fromEntries(pickedIds.map((id) => [id, captions[id] ?? ""])),
          // Only when a YouTube channel is actually going out — absent means
          // the server's (postiz.ts's) safe private default, which is the
          // same thing this panel shows when nobody touched the selector.
          ...(youtubePicked ? { youtubePrivacy } : {}),
          // A receipt on file means this workdir already went out — the
          // button below says "Publish again", so the intent IS the force.
          ...(hasReceipt ? { force: true } : {}),
        }),
      });
      const body = (await res.json()) as { ok?: boolean; receipt?: PublishReceiptInfo; error?: string };
      if (!res.ok || body.ok !== true || !body.receipt) {
        // Postiz's own validation message rides VERBATIM (the YouTube
        // panel's save-error posture) — it names the field, we can't.
        setSendError(body.error ?? `publish failed: ${res.status}`);
        return;
      }
      setSent(body.receipt);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      window.clearInterval(poll);
      setProgress(null);
      setBusy(false);
    }
  };

  // The one POST both the per-network button and the batch share — errors
  // land in regenResult and never throw, which is what lets the batch loop
  // continue past a failed network.
  const regenerateOne = async (
    network: string,
    ids: string[],
    currentCaption: string,
    instruction: string,
  ): Promise<void> => {
    setRegenResult((prev) => ({ ...prev, [network]: {} }));
    // A fresh result starts collapsed again — the old expansion was consent
    // to read the OLD list, not whatever the next run produces.
    setNotesOpen((prev) => ({ ...prev, [network]: false }));
    try {
      const res = await fetch("/api/publish/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `currentCaption` is what the box holds RIGHT NOW, manual edits
        // included — the model must see what the user sees.
        body: JSON.stringify({ network, instruction, currentCaption }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        caption?: string;
        usage?: string;
        notes?: string[];
        error?: string;
      };
      if (!res.ok || body.ok !== true || typeof body.caption !== "string") {
        // The server's message rides VERBATIM (the publish error posture).
        setRegenResult((prev) => ({
          ...prev,
          [network]: { error: body.error ?? `regenerate failed: ${res.status}` },
        }));
        return;
      }
      const next = body.caption;
      // The caption fan-out the textarea's onChange uses: one network's text
      // writes to every channel id in the group.
      setCaptions((prev) => ({
        ...prev,
        ...Object.fromEntries(ids.map((id) => [id, next])),
      }));
      setRegenResult((prev) => ({
        ...prev,
        [network]: { usage: body.usage, notes: body.notes ?? [] },
      }));
    } catch (err) {
      setRegenResult((prev) => ({
        ...prev,
        [network]: { error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const onRegenerate = async (network: string, ids: string[], currentCaption: string): Promise<void> => {
    const instruction = (regenInstruction[network] ?? "").trim();
    if (instruction.length === 0) return;
    setRegenBusy(network);
    try {
      await regenerateOne(network, ids, currentCaption, instruction);
    } finally {
      setRegenBusy(null);
    }
  };

  const onRegenerateAll = async (): Promise<void> => {
    const shared = batchInstruction.trim();
    if (shared.length === 0) return;
    // Only the groups whose caption box is on screen: ≥1 selected channel is
    // exactly the condition the box renders under.
    const targets = groups.filter((g) => g.channels.some((c) => selected[c.id] === true));
    if (targets.length === 0) return;
    try {
      for (let i = 0; i < targets.length; i++) {
        const group = targets[i]!;
        const ids = group.channels.map((c) => c.id);
        const perNetwork = (regenInstruction[group.network] ?? "").trim();
        // A non-empty per-network instruction WINS over the shared one: a
        // network-specific correction shouldn't be flattened by the batch.
        const instruction = perNetwork.length > 0 ? perNetwork : shared;
        setBatchProgress({ network: group.network, index: i + 1, total: targets.length });
        setRegenBusy(group.network);
        // Sequential on purpose (server single-flight, 409 on parallel); a
        // failed network stores its error and the loop moves on.
        await regenerateOne(group.network, ids, captions[ids[0]!] ?? group.caption, instruction);
      }
    } finally {
      setRegenBusy(null);
      setBatchProgress(null);
    }
  };

  const onGeneratePack = async (): Promise<void> => {
    setGenBusy(true);
    setGenError(null);
    try {
      const res = await fetch("/api/youtube/generate", { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; usage?: string; error?: string };
      if (!res.ok || body.ok !== true) {
        // The server's message rides VERBATIM (the publish error posture).
        setGenError(body.error ?? `generate failed: ${res.status}`);
        return;
      }
      setGenUsage(body.usage ?? null);
      // The pack now exists server-side — refetch so packAvailable flips
      // and the caption boxes prefill from it.
      await load();
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenBusy(false);
    }
  };

  const receipt = sent ?? info?.receipt ?? null;

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div data-testid="publish-modal" style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={title}>Publish to social</div>
          <button style={closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {loadError ? (
          <div data-testid="publish-load-error" style={errorText}>
            Couldn't load publish state: {loadError}
          </div>
        ) : info === null ? (
          <div style={subtitle}>Loading…</div>
        ) : !info.configured ? (
          <div data-testid="publish-unconfigured" style={{ ...subtitle, marginTop: 12 }}>
            {NOT_CONFIGURED_MESSAGE}
          </div>
        ) : info.reachable === false ? (
          <div data-testid="publish-unreachable" style={{ ...subtitle, marginTop: 12 }}>
            Postiz didn't answer: {info.reason}
          </div>
        ) : !info.packAvailable ? (
          <div data-testid="publish-no-pack" style={{ ...subtitle, marginTop: 12 }}>
            {NO_PACK_MESSAGE}
            <div style={{ marginTop: 10 }}>
              {/* The way out that costs one LLM call instead of a re-produce:
                  POST /api/youtube/generate asks the run's own provider. */}
              <button
                type="button"
                data-testid="publish-generate-pack"
                disabled={genBusy}
                onClick={() => void onGeneratePack()}
                style={chipStyle}
              >
                {genBusy ? "Generating captions… (one LLM call)" : "Generate captions"}
              </button>
            </div>
            {genError !== null ? (
              <div data-testid="publish-generate-error" style={errorText}>
                {genError}
              </div>
            ) : null}
          </div>
        ) : !info.outPathExists ? (
          <div data-testid="publish-no-render" style={{ ...subtitle, marginTop: 12 }}>
            {NO_RENDER_MESSAGE}
          </div>
        ) : sent !== null ? (
          <div data-testid="publish-done" style={{ ...subtitle, marginTop: 12 }}>
            {sent.when.kind === "now"
              ? `Published to ${sent.targets.length} account(s).`
              : `Scheduled for ${sent.when.iso} on ${sent.targets.length} account(s).`}
            {sent.postIds.length > 0 ? ` Posts: ${sent.postIds.join(", ")}.` : ""} Track it in
            your Postiz launches view.
          </div>
        ) : (
          <>
            {genUsage !== null ? (
              // The generation's spend line survives the refetch that just
              // replaced the no-pack state with these controls — the cost
              // must stay visible after the state it was shown in is gone.
              <div data-testid="publish-generate-usage" style={{ ...subtitle, marginTop: 8 }}>
                {genUsage}
              </div>
            ) : null}
            {receipt !== null ? (
              <div data-testid="publish-receipt-note" style={{ ...subtitle, marginTop: 8 }}>
                This project already published on {receipt.publishedAt} to{" "}
                {receipt.targets.map((t) => t.provider).join(", ")} — publishing again will post
                it again.
              </div>
            ) : null}
            <div style={{ marginTop: 16 }}>
              <label style={labelStyle}>Accounts</label>
              {(info.integrations ?? []).length === 0 ? (
                <div style={subtitle}>
                  No accounts connected in Postiz yet — connect them there first.
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <input
                  data-testid="publish-regen-all-instruction"
                  placeholder='One instruction for every selected network, e.g. "shorter, no hashtags"'
                  value={batchInstruction}
                  onChange={(e) => setBatchInstruction(e.target.value)}
                  style={{ ...textInput, flex: 1, padding: "6px 10px", fontSize: 12 }}
                />
                <button
                  type="button"
                  data-testid="publish-regen-all"
                  disabled={
                    regenBusy !== null ||
                    batchProgress !== null ||
                    batchInstruction.trim().length === 0 ||
                    pickedIds.length === 0
                  }
                  onClick={() => void onRegenerateAll()}
                  style={chipStyle}
                >
                  Regenerate selected captions
                </button>
              </div>
              {batchProgress !== null ? (
                <div
                  data-testid="publish-regen-all-progress"
                  style={{ ...subtitle, marginBottom: 8 }}
                >
                  Regenerating {batchProgress.network}… {batchProgress.index}/{batchProgress.total}
                </div>
              ) : null}
              {groups.map((group) => {
                // ONE caption per NETWORK (publishGroups.ts owns the why):
                // four LinkedIn channels are one post, not four. A group is
                // selected when ANY of its channels is, and typing writes the
                // text to every channel in it — the request still carries a
                // caption per integration id, so the server is unchanged.
                const ids = group.channels.map((c) => c.id);
                // SELECTION is per channel, the CAPTION is per network. One
                // box for four LinkedIn channels is what nobody wants to type
                // four times; one checkbox for four channels is not — picking
                // two of three Facebook pages is a normal thing to want.
                const pickedInGroup = ids.filter((id) => selected[id] === true);
                const on = pickedInGroup.length > 0;
                const cap = panelCaptionCap(group.channels[0]!.provider);
                const text = captions[ids[0]!] ?? group.caption;
                return (
                  <div key={group.network} style={accountBox}>
                    <div style={accountRow}>
                      <span style={providerTag}>{group.network}</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {group.channels.map((channel) => {
                          const picked = selected[channel.id] === true;
                          // Over-cap channels are unpickable, not silently
                          // dropped at send time: the 5:20-vs-Threads-5:00
                          // publish should be refused HERE, with the cap
                          // named, before anything uploads.
                          const note = overCapNote(info.durationSec, capById[channel.id]);
                          return (
                            <button
                              key={channel.id}
                              type="button"
                              data-testid={`publish-chip-${channel.id}`}
                              aria-pressed={picked}
                              disabled={note !== null}
                              title={note ?? undefined}
                              onClick={() =>
                                setSelected((prev) => ({ ...prev, [channel.id]: !picked }))
                              }
                              style={{
                                ...chipStyle,
                                ...(picked ? chipOnStyle : {}),
                                ...(note !== null ? chipOverCapStyle : {}),
                              }}
                            >
                              {channel.name}
                              {note !== null ? ` — ${note}` : ""}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {on ? (
                      <>
                        {group.mixed ? (
                          <div
                            data-testid={`publish-mixed-${group.network}`}
                            style={{ ...subtitle, marginBottom: 6 }}
                          >
                            These channels had different captions — editing here sets one for
                            every channel you pick in this group.
                          </div>
                        ) : null}
                        <textarea
                          data-testid={`publish-caption-${group.network}`}
                          value={text}
                          rows={4}
                          onChange={(e) =>
                            setCaptions((prev) => ({
                              ...prev,
                              ...Object.fromEntries(ids.map((id) => [id, e.target.value])),
                            }))
                          }
                          style={captionArea}
                        />
                        <div
                          data-testid={`publish-count-${group.network}`}
                          style={{
                            ...counterText,
                            ...(text.length > cap ? { color: "#FF5C5C" } : {}),
                          }}
                        >
                          {text.length} / {cap}
                          {pickedInGroup.length > 1
                            ? ` · posts to ${pickedInGroup.length} channels`
                            : ""}
                        </div>
                        {group.network === "youtube" ? (
                          // The one platform whose upload carries a privacy
                          // status, so the control lives in ITS group rather
                          // than in the shared footer. Before this, every
                          // panel publish took postiz.ts's private default
                          // with no way to override it, and two videos the
                          // user believed were published sat private on the
                          // channel (2026-08-29).
                          <div style={{ marginTop: 8 }}>
                            <label style={{ ...counterText, marginRight: 8 }} htmlFor="publish-youtube-privacy">
                              Privacy
                            </label>
                            <select
                              id="publish-youtube-privacy"
                              data-testid="publish-youtube-privacy"
                              value={youtubePrivacy}
                              onChange={(e) =>
                                // The option list is PANEL_YOUTUBE_PRIVACIES,
                                // so the cast names what the DOM already
                                // guarantees; the server re-parses with zod
                                // regardless — a wrong word is a 400, never a
                                // silent fallback to a wider audience.
                                setYoutubePrivacy(e.target.value as PanelYoutubePrivacy)
                              }
                              style={selectStyle}
                            >
                              {PANEL_YOUTUBE_PRIVACIES.map((p) => (
                                <option key={p} value={p}>
                                  {p === "private"
                                    ? "Private (default)"
                                    : p === "unlisted"
                                      ? "Unlisted"
                                      : "Public"}
                                </option>
                              ))}
                            </select>
                            {youtubePrivacyNote(youtubePrivacy) !== null ? (
                              <div
                                data-testid="publish-youtube-privacy-note"
                                style={{ ...subtitle, color: "#E5B300" }}
                              >
                                {youtubePrivacyNote(youtubePrivacy)}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                          <input
                            data-testid={`publish-regen-instruction-${group.network}`}
                            placeholder='Fix the caption, e.g. "the 50 teams figure was an example, not a fact"'
                            value={regenInstruction[group.network] ?? ""}
                            onChange={(e) =>
                              setRegenInstruction((prev) => ({
                                ...prev,
                                [group.network]: e.target.value,
                              }))
                            }
                            style={{ ...textInput, flex: 1, padding: "6px 10px", fontSize: 12 }}
                          />
                          <button
                            type="button"
                            data-testid={`publish-regen-${group.network}`}
                            disabled={
                              regenBusy !== null ||
                              batchProgress !== null ||
                              (regenInstruction[group.network] ?? "").trim().length === 0
                            }
                            onClick={() => void onRegenerate(group.network, ids, text)}
                            style={chipStyle}
                          >
                            {regenBusy === group.network ? "Regenerating…" : "Regenerate"}
                          </button>
                        </div>
                        {regenResult[group.network]?.error !== undefined ? (
                          <div
                            data-testid={`publish-regen-error-${group.network}`}
                            style={errorText}
                          >
                            {regenResult[group.network]!.error}
                          </div>
                        ) : null}
                        {regenResult[group.network]?.usage !== undefined ? (
                          <div
                            data-testid={`publish-regen-usage-${group.network}`}
                            style={{ ...subtitle, marginTop: 4 }}
                          >
                            {regenResult[group.network]!.usage}
                          </div>
                        ) : null}
                        {(regenResult[group.network]?.notes ?? []).length > 0 ? (
                          <>
                            {/* Collapsed by default (the ~45-line flood):
                                the transcript help-toggle idiom, a button
                                with aria-expanded, not a native <details> —
                                nothing else in the editor uses one. */}
                            <button
                              type="button"
                              data-testid={`publish-regen-notes-toggle-${group.network}`}
                              aria-expanded={notesOpen[group.network] === true}
                              onClick={() =>
                                setNotesOpen((prev) => ({
                                  ...prev,
                                  [group.network]: prev[group.network] !== true,
                                }))
                              }
                              style={notesToggle}
                            >
                              {regenNotesSummary(regenResult[group.network]!.notes!.length)}{" "}
                              {notesOpen[group.network] === true ? "▾" : "▸"}
                            </button>
                            {notesOpen[group.network] === true
                              ? regenResult[group.network]!.notes!.map((note) => (
                                  // Advisory grounding notes, the produce
                                  // report's spelling — captions carry brand
                                  // words the take never speaks, so these
                                  // inform, never block.
                                  <div
                                    key={note}
                                    data-testid={`publish-regen-note-${group.network}`}
                                    style={{ ...subtitle, marginTop: 2, color: "#E5B300" }}
                                  >
                                    {note}
                                  </div>
                                ))
                              : null}
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 16 }}>
              <label style={labelStyle}>When</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  ref={scheduleRef}
                  data-testid="publish-schedule"
                  type="datetime-local"
                  value={scheduleLocal}
                  onChange={(e) => setScheduleLocal(e.target.value)}
                  // The WHOLE field opens the calendar, not just the browser's
                  // 12px icon (2026-08-29): the native control reads as a text
                  // mask, so it looked like something to type by hand.
                  // `showPicker` throws without a user gesture and is absent in
                  // some engines — either way typing still works, which is why
                  // this is a bare try/catch rather than a capability probe.
                  onClick={() => {
                    try {
                      scheduleRef.current?.showPicker?.();
                    } catch {
                      // Typing still works; nothing to report.
                    }
                  }}
                  style={{ ...textInput, width: "auto", cursor: "pointer" }}
                />
                {SCHEDULE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    data-testid={`publish-when-${preset.label.replace(/\s+/g, "-").toLowerCase()}`}
                    onClick={() => setScheduleLocal(preset.at(new Date()))}
                    style={chipStyle}
                  >
                    {preset.label}
                  </button>
                ))}
                {scheduleLocal.trim().length > 0 ? (
                  <button
                    type="button"
                    data-testid="publish-when-clear"
                    onClick={() => setScheduleLocal("")}
                    style={chipStyle}
                  >
                    Clear
                  </button>
                ) : null}
                <span style={subtitle}>
                  {schedule === null ? "empty = publish now" : `scheduled: ${schedule}`}
                </span>
              </div>
            </div>
            {sendError ? (
              <div data-testid="publish-error" style={errorText}>
                {sendError}
              </div>
            ) : null}
            {busy ? (
              <div data-testid="publish-busy-note" style={{ ...subtitle, marginTop: 12 }}>
                Encoding the delivery file and uploading through Postiz — this can take a few
                minutes for a long video.
              </div>
            ) : null}
            {busy ? (
              // The live line the poll feeds — same text as the button, in a
              // place a screen reader and a test can both find it.
              <div data-testid="publish-progress" style={{ ...subtitle, marginTop: 4 }}>
                {publishBusyLabel(progress)}
              </div>
            ) : null}
            <div style={footerRow}>
              <div style={footNote}>
                Sends through your Postiz instance, on your accounts — nothing goes anywhere
                until you press the button.
              </div>
              <button
                data-testid="publish-send"
                style={confirmBtn}
                disabled={busy || pickedIds.length === 0 || scheduleInvalid}
                onClick={() => void onPublish()}
              >
                {busy
                  ? // The POST runs the delivery encode synchronously before
                    // the upload (edit.ts), so the button says where that
                    // wait IS — live percent/ETA from the progress poll,
                    // falling back to the static line when the server
                    // reports nothing.
                    publishBusyLabel(progress)
                  : hasReceipt
                    ? "Publish again"
                    : schedule !== null
                      ? "Schedule"
                      : "Publish now"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ---- styles (the YoutubePanel palette) -------------------------------------

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 60,
};

const panel: React.CSSProperties = {
  width: 640,
  maxWidth: "calc(100vw - 48px)",
  maxHeight: "calc(100vh - 96px)",
  overflowY: "auto",
  background: "#121218",
  border: "1px solid #2C2C38",
  borderRadius: 10,
  padding: 24,
  boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const title: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#EDEDF2",
  letterSpacing: "-0.01em",
};

const closeBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#8B8B9E",
  fontSize: 16,
  cursor: "pointer",
  padding: "4px 8px",
  borderRadius: 4,
};

const subtitle: React.CSSProperties = {
  fontSize: 13,
  color: "#8B8B9E",
  marginTop: 6,
  lineHeight: 1.4,
};

const chipStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3a3a44",
  borderRadius: 999,
  color: "#c9c9d4",
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 10px",
};

const chipOverCapStyle: React.CSSProperties = {
  opacity: 0.45,
  cursor: "not-allowed",
};

const chipOnStyle: React.CSSProperties = {
  background: "#5b8cff",
  borderColor: "#5b8cff",
  color: "#0b0b0f",
  fontWeight: 700,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  marginBottom: 8,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const textInput: React.CSSProperties = {
  boxSizing: "border-box",
  background: "#09090D",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: "10px 14px",
  color: "#EDEDF2",
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  outline: "none",
};

// The modal palette's `textInput`, sized for a three-option dropdown sitting
// beside its label rather than a full-width field.
const selectStyle: React.CSSProperties = {
  ...textInput,
  width: "auto",
  padding: "5px 8px",
  fontSize: 12,
  cursor: "pointer",
};

const accountBox: React.CSSProperties = {
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
  padding: "10px 14px",
  marginBottom: 8,
};

const accountRow: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  cursor: "pointer",
};

const providerTag: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#8B8B9E",
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  minWidth: 72,
};

const accountName: React.CSSProperties = {
  fontSize: 13,
  color: "#EDEDF2",
};

const captionArea: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 8,
  background: "#121218",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: "8px 12px",
  color: "#EDEDF2",
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  outline: "none",
  resize: "vertical",
};

const notesToggle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  marginTop: 4,
  cursor: "pointer",
  textAlign: "left",
  fontSize: 12,
  color: "#E5B300",
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
};

const counterText: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: "#8B8B9E",
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
};

const errorText: React.CSSProperties = {
  marginTop: 12,
  color: "#FF5C5C",
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  whiteSpace: "pre-wrap",
};

const footerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  marginTop: 20,
};

const footNote: React.CSSProperties = {
  fontSize: 12,
  color: "#8B8B9E",
  lineHeight: 1.4,
};

const confirmBtn: React.CSSProperties = {
  background: "#00E5A3",
  border: "none",
  borderRadius: 6,
  color: "#051A13",
  padding: "9px 20px",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
  boxShadow: "0 2px 10px rgba(0,229,163,0.3)",
};
