import { z } from "zod/v4";
import type { Theme } from "./scene-schema";

/**
 * A look is a theme preset (design §2.2), selected by `--look` or the config
 * key `look`. It is a layer, not a theme of its own: precedence per run is
 * defaults < look < config `theme` < overrides.json, so a user restyles the
 * explainer look for another product by setting `accent`/`accent2` in config
 * and keeps the rest. A zod enum so a typo'd `--look explainr` is refused
 * rather than rendering the default look the user did not ask for.
 */
export const LOOK_IDS = ["default", "explainer"] as const;
export const LookSchema = z.enum(LOOK_IDS);
export type Look = z.infer<typeof LookSchema>;

/**
 * The author's Video Playbook palette and type, mapped onto theme roles
 * (design §2.2's table). `fonts: "bundled"` and `motion: "explainer"` ride
 * here and nowhere else, which is what keeps the font loading and the new
 * motion off for every run that does not ask for this look (plan G6).
 *
 * Each font stack starts with the bundled family and falls back to the old
 * stack's system fonts, so a render whose font files failed to load still
 * draws in a sans and a monospace.
 */
export const EXPLAINER_THEME: Readonly<Partial<Theme>> = Object.freeze({
  bg: "#3A4A5C",
  fg: "#FFFFFF",
  accent: "#FF8D41",
  accent2: "#7CACF8",
  highlight: "#FFE14D",
  success: "#3DDC84",
  danger: "#FF4D4D",
  cardBg: "#14161C",
  cardBorder: "#2B3140",
  muted: "#7C86A6",
  info: "#5FD7FF",
  ink: "#0F1013",
  terminalBg: "#0F1320",
  terminalBar: "#1A2034",
  fontDisplay: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  fontMono: "'DejaVu Sans Mono', 'SF Mono', 'Cascadia Code', Consolas, monospace",
  fonts: "bundled",
  motion: "explainer",
});

/**
 * The theme layer a look contributes. `{}` for "default" rather than the
 * default theme's values: an empty layer is what guarantees a run without
 * `--look` resolves exactly as it did before looks existed. Returns a copy,
 * so a caller that edits its theme cannot restyle the next run's look.
 */
export function lookTheme(look: Look): Partial<Theme> {
  return look === "explainer" ? { ...EXPLAINER_THEME } : {};
}
