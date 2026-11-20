/**
 * `@ossclip/scenes/draw`: the only project code an LLM-drawn scene may import
 * (storyboard design §4, §167). Time, theme, frame size and safe area come
 * from hooks over the host's `DrawProvider`; the parts are the pattern
 * primitives reading the theme from it.
 *
 * Every runtime export but the four below is listed in `DRAW_KIT_EXPORTS`
 * (draw-kit.test.ts pins it), and exports are only added, never renamed or
 * removed: an approved scene names them in its code.
 */

/** Recorded with every drawn version, so a scene can be matched to the kit it was written for. */
export const DRAW_KIT_VERSION = 1;

export {
  DrawProvider,
  useFrameSize,
  useSafeArea,
  useSceneTime,
  useTheme,
  type DrawContextValue,
} from "./context";
// The seconds-based helpers only. anim.ts's `pop`, `rise` and `fade` take a
// spring progress a drawn scene has no frame-based spring to produce.
export {
  beatStarts,
  bobPx,
  bump,
  caretOn,
  countAt,
  easeInOut,
  fadeIn,
  parseCount,
  popScale,
  riseIn,
  typedChars,
} from "../motion";
export { Asset, Card, Icon, NumberBadge, PhoneFrame, Pill, Sticker } from "./parts";
export { DRAW_KIT_EXPORTS, DRAW_KIT_REFERENCE } from "./reference";
