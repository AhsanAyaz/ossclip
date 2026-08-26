import React, { useCallback, useEffect, useState } from "react";

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

/** The plain sentences the panel's blocked states show instead of controls. */
export const NOT_CONFIGURED_MESSAGE =
  "Publishing goes through your own self-hosted Postiz instance (postiz.com): set " +
  '"postizUrl" in ~/.ossclip/config.json and OSSCLIP_POSTIZ_API_KEY in ~/.ossclip/.env, ' +
  "then restart the editor.";
export const NO_PACK_MESSAGE =
  "No captions to post yet — run produce with --youtube (or approve a pack in the SEO " +
  "panel) so publish has copy to send.";
export const NO_RENDER_MESSAGE = "No finished render to publish — render first.";

/** `<input type="datetime-local">`'s value → the ISO the server validates.
 * Pure so the empty/garbage matrix is testable without a mount. */
export function scheduleIso(local: string): string | null {
  if (local.trim().length === 0) return null;
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export interface PublishPanelProps {
  onClose: () => void;
}

export const PublishPanel: React.FC<PublishPanelProps> = ({ onClose }) => {
  const [info, setInfo] = useState<PublishInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<PublishReceiptInfo | null>(null);

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
  const schedule = scheduleIso(scheduleLocal);
  const scheduleInvalid = scheduleLocal.trim().length > 0 && schedule === null;
  const hasReceipt = (info?.receipt ?? null) !== null || sent !== null;

  const onPublish = async (): Promise<void> => {
    setBusy(true);
    setSendError(null);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationIds: pickedIds,
          ...(schedule !== null ? { at: schedule } : {}),
          captions: Object.fromEntries(pickedIds.map((id) => [id, captions[id] ?? ""])),
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
      setBusy(false);
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
              {(info.integrations ?? []).map((integration) => {
                const on = selected[integration.id] === true;
                const cap = panelCaptionCap(integration.provider);
                const text = captions[integration.id] ?? "";
                return (
                  <div key={integration.id} style={accountBox}>
                    <label style={accountRow}>
                      <input
                        data-testid={`publish-check-${integration.id}`}
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          setSelected((prev) => ({ ...prev, [integration.id]: e.target.checked }))
                        }
                      />
                      <span style={providerTag}>{integration.provider}</span>
                      <span style={accountName}>{integration.name}</span>
                    </label>
                    {on ? (
                      <>
                        <textarea
                          data-testid={`publish-caption-${integration.id}`}
                          value={text}
                          rows={4}
                          onChange={(e) =>
                            setCaptions((prev) => ({ ...prev, [integration.id]: e.target.value }))
                          }
                          style={captionArea}
                        />
                        <div
                          data-testid={`publish-count-${integration.id}`}
                          style={{
                            ...counterText,
                            ...(text.length > cap ? { color: "#FF5C5C" } : {}),
                          }}
                        >
                          {text.length} / {cap}
                        </div>
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
                  data-testid="publish-schedule"
                  type="datetime-local"
                  value={scheduleLocal}
                  onChange={(e) => setScheduleLocal(e.target.value)}
                  style={{ ...textInput, width: "auto" }}
                />
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
                  ? "Publishing…"
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
