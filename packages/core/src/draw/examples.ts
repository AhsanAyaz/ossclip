/**
 * The two worked examples the draw prompt carries (storyboard design §3,
 * §167): one built from kit parts with timed beats, one with a character
 * drawn in SVG paths. An LLM copies the shape of what it is shown, so these
 * are the house style for a drawn scene: beats as fractions of
 * `durationSec`, layout from the safe area so one file works in 1080x1920
 * and 1920x1080, theme fonts and palette on interface parts.
 *
 * The character example is there because the kit pulls every shot toward
 * cards and pills (design, Risks): a model shown only kit parts draws only
 * kit parts.
 *
 * Plain strings with no imports, so the mock provider (which the browser
 * entry can reach) can return one without loading the compiler. Both must
 * pass the static check (core test) and the real type check against the
 * kit (apps/cli/test/draw-examples.test.ts); a change here that breaks
 * either is a broken prompt.
 */

/** Kit parts with timed beats: a stat card counts up while three pills pop in beside it. */
export const DRAW_EXAMPLE_KIT = `import { AbsoluteFill } from "remotion";
import {
  Card,
  Pill,
  beatStarts,
  countAt,
  fadeIn,
  parseCount,
  popScale,
  riseIn,
  useSafeArea,
  useSceneTime,
  useTheme,
} from "@ossclip/scenes/draw";

// A stat card counts up while three pills pop in beside it, one beat apart.
const STAT = "4,494";
const LABEL = "takes cut automatically";
const PILLS: { text: string; mark: "tick" | "cross" }[] = [
  { text: "Filler words cut", mark: "tick" },
  { text: "Dead air cut", mark: "tick" },
  { text: "Manual trims", mark: "cross" },
];

export default function Scene({ durationSec }: { durationSec: number }) {
  const t = useSceneTime();
  const theme = useTheme();
  const area = useSafeArea();

  // Every beat is a fraction of durationSec, so the scene can be rendered
  // again at another length. The last pill lands at about 70% of the scene
  // and everything then holds to the end.
  const cardStart = 0.05 * durationSec;
  const countSec = 0.4 * durationSec;
  const pillStarts = beatStarts(PILLS.length, 0.12 * durationSec, 0.35 * durationSec);

  // Sizes come from the safe area, so the same file works in portrait
  // (pills under the card) and landscape (pills beside it).
  const portrait = area.height > area.width;
  const unit = Math.min(area.width, area.height);
  const parsed = parseCount(STAT);
  const statText = parsed ? countAt(parsed, t - cardStart, countSec) : STAT;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: area.x,
          top: area.y,
          width: area.width,
          height: area.height,
          display: "flex",
          flexDirection: portrait ? "column" : "row",
          alignItems: "center",
          justifyContent: "center",
          gap: Math.round(unit * 0.06),
        }}
      >
        <div style={{ opacity: fadeIn(t, cardStart, 0.15), transform: \`scale(\${popScale(t - cardStart)})\` }}>
          <Card border={theme.accent} widthPx={Math.round(portrait ? area.width * 0.86 : area.width * 0.42)}>
            <div
              style={{
                fontFamily: theme.fontDisplay,
                fontSize: Math.round(unit * 0.17),
                fontWeight: 900,
                lineHeight: 1,
                color: theme.accent,
              }}
            >
              {statText}
            </div>
            <div style={{ fontFamily: theme.fontDisplay, fontSize: Math.round(unit * 0.045), color: theme.muted, marginTop: Math.round(unit * 0.02) }}>
              {LABEL}
            </div>
          </Card>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: portrait ? "center" : "flex-start", gap: Math.round(unit * 0.03) }}>
          {PILLS.map((pill, i) => {
            const start = pillStarts[i] ?? 0;
            return (
              <div
                key={pill.text}
                style={{
                  opacity: fadeIn(t, start, 0.15),
                  transform: \`translateY(\${riseIn(t, start)}px) scale(\${popScale(t - start)})\`,
                }}
              >
                <Pill
                  text={pill.text}
                  mark={pill.mark}
                  border={pill.mark === "tick" ? theme.success : theme.danger}
                  sizePx={Math.max(34, Math.round(unit * 0.045))}
                />
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}
`;

/** A character drawn in SVG paths: a goldfish swims in with its tail swinging, then a speech bubble fades in. */
export const DRAW_EXAMPLE_CHARACTER = `import { AbsoluteFill, interpolate } from "remotion";
import { bobPx, easeInOut, fadeIn, popScale, useSafeArea, useSceneTime, useTheme } from "@ossclip/scenes/draw";

// A goldfish swims in, tail swinging, and then says it forgot the plan.
// The fish is an illustration, so it has its own colours; the speech bubble
// is interface, so it uses the theme's palette and font.
const BODY = "M -115 0 C -90 -72, 60 -84, 122 -12 C 134 0, 134 12, 122 20 C 60 84, -90 72, -115 0 Z";
const TAIL = "M 0 0 C -40 -52, -82 -72, -98 -56 C -78 -20, -78 20, -98 56 C -82 72, -40 52, 0 0 Z";
const DORSAL = "M -20 -58 C 0 -110, 52 -106, 62 -62 Z";
const SIDE_FIN = "M 10 22 C 28 54, 60 60, 72 38 C 52 32, 30 26, 10 22 Z";
const GILL = "M 52 -40 C 66 -16, 66 16, 52 40";
const SAYS = "Wait, what was the plan?";

export default function Scene({ durationSec }: { durationSec: number }) {
  const t = useSceneTime();
  const theme = useTheme();
  const area = useSafeArea();

  // Beats as fractions of the duration; the last state holds to the end,
  // while the tail and the bob keep moving as idle motion.
  const swimSec = 0.35 * durationSec;
  const bubbleStart = 0.5 * durationSec;

  // The drawing is 380 x 260 units (the viewBox) and is scaled to fit the
  // safe area in either orientation.
  const width = Math.min(area.width * 0.8, area.height * 0.5);
  const height = (width * 260) / 380;
  const unit = Math.min(area.width, area.height);
  const centerX = area.x + area.width / 2;
  const centerY = area.y + area.height * 0.62;

  // Swims in from the safe area's left edge, then stays.
  const startX = area.x + width / 2 - centerX;
  const swimX = interpolate(easeInOut(t, swimSec), [0, 1], [startX, 0]);
  const bob = bobPx(t, unit * 0.012, 2.2);
  // The tail swings faster while swimming; a sine of time is the same at any frame order.
  const tailDeg = 18 * Math.sin(t * Math.PI * 2 * (t < swimSec ? 3 : 1.4));
  const finDeg = 6 * Math.sin(t * Math.PI * 2 * 1.1);
  const lookX = 3 * Math.sin(t * 1.7);
  const fishLeft = centerX - width / 2 + swimX;
  const fishTop = centerY - height / 2 + bob;

  return (
    <AbsoluteFill>
      <svg
        width={width}
        height={height}
        viewBox="-220 -130 380 260"
        style={{ position: "absolute", left: fishLeft, top: fishTop, opacity: fadeIn(t, 0, 0.25) }}
      >
        <defs>
          <linearGradient id="fishBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffb547" />
            <stop offset="1" stopColor="#f0631c" />
          </linearGradient>
        </defs>
        <g transform={\`translate(-112 0) rotate(\${tailDeg})\`}>
          <path d={TAIL} fill="#f47b25" stroke="#b9420c" strokeWidth={4} />
        </g>
        <g transform={\`rotate(\${finDeg} 0 -58)\`}>
          <path d={DORSAL} fill="#f47b25" stroke="#b9420c" strokeWidth={4} />
        </g>
        <path d={BODY} fill="url(#fishBody)" stroke="#b9420c" strokeWidth={5} />
        <path d={GILL} fill="none" stroke="#b9420c" strokeWidth={4} strokeLinecap="round" />
        <g transform={\`rotate(\${-finDeg * 2} 10 22)\`}>
          <path d={SIDE_FIN} fill="#ffcf7a" stroke="#b9420c" strokeWidth={3} />
        </g>
        <circle cx={84} cy={-18} r={17} fill="#ffffff" stroke="#3a1a08" strokeWidth={3} />
        <circle cx={86 + lookX} cy={-18} r={8} fill="#1d0f05" />
        <path d="M 116 10 Q 124 16 132 10" fill="none" stroke="#3a1a08" strokeWidth={4} strokeLinecap="round" />
        {[0, 1, 2].map((i) => {
          // Three air bubbles on a loop; each one's phase is fixed by its index.
          const p = (t * 0.55 + i / 3) % 1;
          return (
            <circle key={i} cx={138 + 6 * Math.sin(p * 6 + i)} cy={-6 - p * 112} r={5 + 5 * p} fill="none" stroke="#9fd8ff" strokeWidth={3} opacity={1 - p} />
          );
        })}
      </svg>
      {/* A full-width row over the fish centres the bubble inside the safe area. */}
      <div
        style={{
          position: "absolute",
          left: area.x,
          top: fishTop - unit * 0.03,
          width: area.width,
          display: "flex",
          justifyContent: "center",
          transform: "translateY(-100%)",
        }}
      >
        <div
          style={{
            maxWidth: area.width * 0.9,
            transform: \`scale(\${popScale(t - bubbleStart)})\`,
            transformOrigin: "50% 100%",
            opacity: fadeIn(t, bubbleStart),
            background: theme.cardBg,
            border: \`4px solid \${theme.accent}\`,
            borderRadius: theme.radiusPx,
            padding: \`\${Math.round(unit * 0.025)}px \${Math.round(unit * 0.04)}px\`,
            fontFamily: theme.fontDisplay,
            fontSize: Math.round(unit * 0.055),
            fontWeight: 800,
            color: theme.fg,
            textAlign: "center",
          }}
        >
          {SAYS}
        </div>
      </div>
    </AbsoluteFill>
  );
}
`;

/** The examples in the order the prompt shows them, each with the one line that introduces it. */
export const DRAW_EXAMPLES: readonly { description: string; code: string }[] = [
  {
    description: "Built from kit parts with timed beats: a stat card counts up while three pills pop in beside it, one beat apart.",
    code: DRAW_EXAMPLE_KIT,
  },
  {
    description:
      "A character drawn with SVG paths that moves: a goldfish with a body, tail, fins and an eye swims in, its tail swinging with a sine of time, bobbing, and a speech bubble fades in.",
    code: DRAW_EXAMPLE_CHARACTER,
  },
];
