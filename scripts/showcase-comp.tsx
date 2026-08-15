import React from "react";
import {
  AbsoluteFill,
  Composition,
  Sequence,
  interpolate,
  registerRoot,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// ---- Color Palette ----
const C = {
  bg: "#08080E",
  panel: "#10101A",
  panelBorder: "#252536",
  accentGemini: "#4E82EE",
  accentCyan: "#00E5A3",
  accentPurple: "#B37AF6",
  accentOrange: "#FF9E3B",
  textPrimary: "#EDEDF2",
  textMuted: "#888899",
  textDim: "#555566",
  redDiff: "#FF455B",
  greenDiff: "#00E5A3",
};

// ---- Scene 1: Prompt & Awakening ----
const Scene1_Awakening: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleProgress = spring({ frame, fps, config: { damping: 14, mass: 0.8 } });
  const cardProgress = spring({ frame: frame - 15, fps, config: { damping: 14, mass: 0.8 } });
  const pulse = Math.sin(frame * 0.15) * 0.15 + 0.85;

  return (
    <AbsoluteFill style={{ padding: 60, justifyContent: "center", alignItems: "center" }}>
      {/* Glow Badge */}
      <div
        style={{
          transform: `scale(${titleProgress})`,
          opacity: titleProgress,
          background: "linear-gradient(90deg, rgba(78,130,238,0.2) 0%, rgba(179,122,246,0.2) 100%)",
          border: `1px solid ${C.accentGemini}`,
          padding: "10px 24px",
          borderRadius: 30,
          display: "flex",
          alignItems: "center",
          gap: 12,
          boxShadow: `0 0 ${24 * pulse}px rgba(78,130,238,0.4)`,
        }}
      >
        <span style={{ fontSize: 24 }}>✨</span>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontWeight: 800,
            fontSize: 20,
            color: "#8AB4F8",
            letterSpacing: "0.08em",
          }}
        >
          GEMINI 3.7 FLASH // PAIR PROGRAMMING
        </span>
      </div>

      {/* Main Headline */}
      <div
        style={{
          marginTop: 32,
          textAlign: "center",
          transform: `scale(${titleProgress})`,
          opacity: titleProgress,
        }}
      >
        <h1
          style={{
            fontSize: 54,
            fontWeight: 900,
            color: C.textPrimary,
            letterSpacing: "-0.03em",
            margin: 0,
            lineHeight: 1.15,
          }}
        >
          Next-Gen AI &amp; CLI Overhaul
        </h1>
        <p style={{ fontSize: 22, color: C.textMuted, marginTop: 12 }}>
          Upgrading model engine &amp; building a cybernetic terminal HUD
        </p>
      </div>

      {/* Prompt Card */}
      <div
        style={{
          marginTop: 40,
          width: "100%",
          maxWidth: 860,
          background: C.panel,
          border: `1px solid ${C.panelBorder}`,
          borderRadius: 16,
          padding: "24px 30px",
          transform: `translateY(${(1 - cardProgress) * 40}px) scale(${cardProgress})`,
          opacity: cardProgress,
          boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#FF5F56" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#FFBD2E" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#27C93F" }} />
          <span style={{ marginLeft: 12, fontSize: 14, color: C.textDim, fontFamily: "ui-monospace, monospace" }}>
            user-directive.md
          </span>
        </div>
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 20,
            color: "#D0D0DC",
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: C.accentCyan }}>&gt;</span> &ldquo;Gemini 3.7 flash is out. Can we integrate that in
          the project... and add crazy (and performant) animation sequences when rendering video? Something video editors
          + developers would LOVE!&rdquo;
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 2: Engine Upgrade & Pricing ----
const Scene2_ModelUpgrade: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const anim = spring({ frame, fps, config: { damping: 14 } });
  const line2Anim = spring({ frame: frame - 15, fps, config: { damping: 14 } });
  const line3Anim = spring({ frame: frame - 30, fps, config: { damping: 14 } });

  return (
    <AbsoluteFill style={{ padding: 60, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", marginBottom: 30, transform: `scale(${anim})`, opacity: anim }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 800,
            color: C.accentCyan,
            letterSpacing: "0.1em",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          PHASE 1 // ENGINE REFACTOR
        </div>
        <h2 style={{ fontSize: 44, fontWeight: 900, color: C.textPrimary, margin: "6px 0 0" }}>
          Upgraded to Gemini 3.7 Flash
        </h2>
      </div>

      {/* Code Card */}
      <div
        style={{
          width: "100%",
          maxWidth: 900,
          background: "#0C0C14",
          border: `1px solid ${C.panelBorder}`,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 50px rgba(0,0,0,0.7)",
          transform: `scale(${anim})`,
          opacity: anim,
        }}
      >
        <div
          style={{
            background: "#161622",
            padding: "12px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: `1px solid ${C.panelBorder}`,
          }}
        >
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 14, color: C.textMuted }}>
            packages/core/src/producer/gemini.ts
          </span>
          <span style={{ fontSize: 13, color: C.accentCyan, fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>
            git diff
          </span>
        </div>

        <div style={{ padding: 24, fontFamily: "ui-monospace, monospace", fontSize: 18, lineHeight: 1.8 }}>
          {/* Diff Line 1 */}
          <div
            style={{
              color: C.redDiff,
              background: "rgba(255, 69, 91, 0.12)",
              padding: "4px 12px",
              borderRadius: 6,
              marginBottom: 8,
            }}
          >
            - export const DEFAULT_GEMINI_MODEL = &quot;gemini-3.6-flash&quot;;
          </div>
          {/* Diff Line 2 */}
          <div
            style={{
              color: C.greenDiff,
              background: "rgba(0, 229, 163, 0.15)",
              padding: "4px 12px",
              borderRadius: 6,
              transform: `translateX(${(1 - line2Anim) * 20}px)`,
              opacity: line2Anim,
              fontWeight: 700,
            }}
          >
            + export const DEFAULT_GEMINI_MODEL = &quot;gemini-3.7-flash&quot;;
          </div>

          {/* Pricing Info */}
          <div
            style={{
              marginTop: 20,
              padding: "16px 20px",
              background: "rgba(78, 130, 238, 0.08)",
              border: "1px solid rgba(78, 130, 238, 0.3)",
              borderRadius: 10,
              transform: `translateY(${(1 - line3Anim) * 20}px)`,
              opacity: line3Anim,
            }}
          >
            <div style={{ color: "#8AB4F8", fontWeight: 700, marginBottom: 6, fontSize: 16 }}>
              📊 Official Active API Pricing Registered
            </div>
            <div style={{ color: C.textPrimary, fontSize: 16 }}>
              ▸ Input: <strong style={{ color: C.accentCyan }}>$0.75</strong> / 1M tokens &nbsp;|&nbsp; Output:{" "}
              <strong style={{ color: C.accentCyan }}>$3.75</strong> / 1M tokens
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---- Synth Oscilloscope Component ----
const SynthWaveVisualizer: React.FC<{ frame: number; width?: number; height?: number }> = ({
  frame,
  width = 460,
  height = 36,
}) => {
  const points: Array<[number, number]> = [];
  const steps = 50;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width;
    const t = (i / steps) * Math.PI * 4 + frame * 0.18;
    const yNorm =
      Math.sin(t) * 0.55 +
      Math.sin(t * 2.3 + frame * 0.08) * 0.3 +
      Math.sin(t * 0.5 - frame * 0.05) * 0.15;
    const y = height / 2 + yNorm * (height * 0.4);
    points.push([x, y]);
  }

  const d = points.reduce(
    (acc, [x, y], idx) =>
      idx === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `${acc} L ${x.toFixed(1)} ${y.toFixed(1)}`,
    "",
  );

  return (
    <div style={{ position: "relative", width, height, display: "flex", alignItems: "center" }}>
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: 0,
          right: 0,
          height: 1,
          background: "rgba(255, 158, 59, 0.25)",
        }}
      />
      <svg width={width} height={height} style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id="synthGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FF9E3B" />
            <stop offset="50%" stopColor="#FFE14D" />
            <stop offset="100%" stopColor="#00E5A3" />
          </linearGradient>
          <filter id="synthGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          d={d}
          fill="none"
          stroke="url(#synthGrad)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#synthGlow)"
        />
      </svg>
    </div>
  );
};

// ---- Scene 3: CyberReel Real-Time HUD ----
const Scene3_CyberReelHUD: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const anim = spring({ frame, fps, config: { damping: 14 } });
  const renderProgressVal = interpolate(frame, [0, 120], [0.15, 0.94], { extrapolateRight: "clamp" });
  const framesRendered = Math.floor(renderProgressVal * 850);
  const currentSec = (renderProgressVal * 28.3).toFixed(1);

  return (
    <AbsoluteFill style={{ padding: 60, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", marginBottom: 24, transform: `scale(${anim})`, opacity: anim }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 800,
            color: C.accentPurple,
            letterSpacing: "0.1em",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          PHASE 2 // REAL-TIME NLE TERMINAL ENGINE
        </div>
        <h2 style={{ fontSize: 44, fontWeight: 900, color: C.textPrimary, margin: "6px 0 0" }}>
          CyberReel Multi-Track HUD
        </h2>
      </div>

      {/* Terminal Mockup */}
      <div
        style={{
          width: "100%",
          maxWidth: 920,
          background: "#080811",
          border: "1px solid #2E2E44",
          borderRadius: 14,
          padding: 24,
          fontFamily: "ui-monospace, monospace",
          boxShadow: "0 20px 60px rgba(0,0,0,0.8), 0 0 40px rgba(0,229,163,0.1)",
          transform: `scale(${anim})`,
          opacity: anim,
        }}
      >
        {/* Terminal Header */}
        <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #1E1E2E", paddingBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>🎬</span>
            <span style={{ fontWeight: 800, color: C.accentCyan, fontSize: 16 }}>
              REMOTION TIMELINE EXPORT // NLE MONITOR
            </span>
          </div>
          <span style={{ color: "#FFE14D", fontWeight: 700, fontSize: 16 }}>
            ⏱ 00:00:{String(Math.floor(Number(currentSec))).padStart(2, "0")}:14 / 00:00:28:15
          </span>
        </div>

        {/* Tracks Area */}
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Track V1 */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, marginBottom: 6 }}>
              <span style={{ color: "#8AB4F8", fontWeight: 700 }}>Track V1 [Video]</span>
              <span style={{ color: C.accentCyan, fontWeight: 800 }}>{(renderProgressVal * 100).toFixed(0)}%</span>
            </div>
            <div style={{ height: 16, background: "#161626", borderRadius: 8, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${renderProgressVal * 100}%`,
                  background: "linear-gradient(90deg, #4E82EE 0%, #00E5A3 100%)",
                  borderRadius: 8,
                  boxShadow: "0 0 16px rgba(0,229,163,0.5)",
                }}
              />
            </div>
          </div>

          {/* Track G1 */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "#121220",
              padding: "10px 16px",
              borderRadius: 8,
              border: "1px solid #222238",
            }}
          >
            <span style={{ color: C.accentPurple, fontWeight: 700, fontSize: 15 }}>Track G1 [Scenes]</span>
            <span style={{ color: C.textPrimary, fontSize: 15 }}>
              Scene 3/5: <strong style={{ color: C.accentCyan }}>CodeComparison (split-left)</strong>
            </span>
          </div>

          {/* Track A1 */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "#121220",
              padding: "10px 16px",
              borderRadius: 8,
              border: "1px solid #222238",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ color: C.accentOrange, fontWeight: 700, fontSize: 15 }}>Track A1 [Synth Wave]</span>
              <span style={{ color: C.textDim, fontSize: 11, marginTop: 2 }}>48kHz · Dual FM Osc</span>
            </div>
            <SynthWaveVisualizer frame={frame} width={420} height={32} />
          </div>
        </div>

        {/* Live Metrics Footer */}
        <div
          style={{
            marginTop: 18,
            paddingTop: 12,
            borderTop: "1px solid #1E1E2E",
            display: "flex",
            justifyContent: "space-between",
            fontSize: 14,
            color: C.textMuted,
          }}
        >
          <span>Frame: <strong style={{ color: C.textPrimary }}>{framesRendered} / 850</strong></span>
          <span>Speed: <strong style={{ color: C.accentCyan }}>1.85x Realtime</strong> (30.0 fps)</span>
          <span>ETA: <strong style={{ color: "#FFE14D" }}>{Math.max(1, Math.round((1 - renderProgressVal) * 15))}s</strong></span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 4: Editor Save-As & Victory ----
const Scene4_EditorAndVictory: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const anim = spring({ frame, fps, config: { damping: 14 } });
  const bannerAnim = spring({ frame: frame - 25, fps, config: { damping: 12, mass: 0.9 } });

  return (
    <AbsoluteFill style={{ padding: 60, justifyContent: "center", alignItems: "center" }}>
      {/* Top Bar Preview */}
      <div
        style={{
          width: "100%",
          maxWidth: 900,
          background: C.panel,
          border: `1px solid ${C.panelBorder}`,
          borderRadius: 12,
          padding: "16px 22px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          transform: `scale(${anim})`,
          opacity: anim,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 20 }}>🎬</span>
          <span style={{ fontWeight: 800, color: C.textPrimary, fontSize: 16 }}>ossclip editor</span>
        </div>

        {/* Split Render Button */}
        <div style={{ display: "flex", alignItems: "center", boxShadow: "0 0 16px rgba(0,229,163,0.3)" }}>
          <button
            style={{
              background: "#00E5A3",
              color: "#051A13",
              fontWeight: 800,
              padding: "10px 18px",
              border: "none",
              borderTopLeftRadius: 6,
              borderBottomLeftRadius: 6,
              fontSize: 15,
            }}
          >
            Render Video ⚡
          </button>
          <button
            style={{
              background: "#00C78E",
              color: "#051A13",
              fontWeight: 800,
              padding: "10px 12px",
              border: "none",
              borderLeft: "1px solid rgba(0,0,0,0.15)",
              borderTopRightRadius: 6,
              borderBottomRightRadius: 6,
              fontSize: 15,
            }}
          >
            📁 Save As…
          </button>
        </div>
      </div>

      {/* Grand Victory Banner */}
      <div
        style={{
          marginTop: 36,
          width: "100%",
          maxWidth: 900,
          background: "linear-gradient(135deg, #0E1020 0%, #080A14 100%)",
          border: "2px solid #00E5A3",
          borderRadius: 16,
          padding: "32px 36px",
          boxShadow: "0 25px 60px rgba(0,0,0,0.9), 0 0 40px rgba(0,229,163,0.25)",
          transform: `scale(${bannerAnim}) translateY(${(1 - bannerAnim) * 30}px)`,
          opacity: bannerAnim,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
          <span style={{ fontSize: 32 }}>🏆</span>
          <div>
            <div style={{ fontSize: 24, fontWeight: 900, color: C.textPrimary, letterSpacing: "-0.01em" }}>
              MASTER REEL PRODUCED &amp; RELEASED
            </div>
            <div style={{ fontSize: 14, color: C.accentCyan, marginTop: 4 }}>
              ossclip v0.1.22 · 106 test suites (1,611 unit &amp; integration tests passed)
            </div>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            background: "#07080E",
            padding: 20,
            borderRadius: 10,
            border: "1px solid #1E2034",
            fontSize: 15,
            color: "#C9C9D8",
          }}
        >
          <div>▸ Engine: <strong style={{ color: "#8AB4F8" }}>Gemini 3.7 Flash API</strong></div>
          <div>▸ Speed: <strong style={{ color: C.accentCyan }}>1.85x Realtime Export</strong></div>
          <div>▸ Cut: <strong style={{ color: "#FFE14D" }}>90.1s (-26% dead air)</strong></div>
          <div>▸ Release: <strong style={{ color: C.accentCyan }}>v0.1.22 on npm + GitHub</strong></div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---- Main Root Composition ----
export const ShowcaseShow: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      {/* Background Radial Glow */}
      <AbsoluteFill
        style={{
          background: "radial-gradient(circle at 50% 30%, rgba(78,130,238,0.15) 0%, rgba(0,0,0,0) 70%)",
        }}
      />

      {/* Sequence 1: 0 - 3.5s (0-105 frames) */}
      <Sequence from={0} durationInFrames={105}>
        <Scene1_Awakening />
      </Sequence>

      {/* Sequence 2: 3.5 - 7.5s (105-225 frames) */}
      <Sequence from={105} durationInFrames={120}>
        <Scene2_ModelUpgrade />
      </Sequence>

      {/* Sequence 3: 7.5 - 12.5s (225-375 frames) */}
      <Sequence from={225} durationInFrames={150}>
        <Scene3_CyberReelHUD />
      </Sequence>

      {/* Sequence 4: 12.5 - 17.5s (375-525 frames) */}
      <Sequence from={375} durationInFrames={150}>
        <Scene4_EditorAndVictory />
      </Sequence>
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Showcase"
      component={ShowcaseShow}
      durationInFrames={525} // 17.5 seconds at 30 fps
      fps={30}
      width={1080}
      height={1080}
    />
  );
};

registerRoot(RemotionRoot);
