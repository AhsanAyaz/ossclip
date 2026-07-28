/**
 * J/K/L transport (PLAN Task 2) — the YouTube/Premiere convention, as the
 * author specified it:
 *
 *   L      play forward; again → faster, and so on
 *   J      play backward; again → back faster
 *   K      stop/play toggle; when it starts playing, it plays at 1×
 *   SPACE  play/pause toggle (handled elsewhere; it never touches the rate)
 *
 * Reverse is a NEGATIVE `playbackRate`: measured on this Remotion version
 * (`calculate-next-frame.js` has an explicit reverse branch), a negative rate
 * genuinely steps frames backwards — no seek loop needed.
 *
 * Pure reducer, because the ladder is logic, not UI.
 */

export interface TransportState {
  /** Signed playback rate; negative is reverse. */
  rate: number;
  playing: boolean;
}

/** The speed ladder L climbs and J mirrors. Top step holds. */
export const RATE_LADDER = [1, 1.5, 2, 4];

export type TransportKey = "J" | "K" | "L";

/** The next ladder step above `abs`, or the top if already there. */
function stepUp(abs: number): number {
  return RATE_LADDER.find((r) => r > abs + 1e-9) ?? RATE_LADDER[RATE_LADDER.length - 1]!;
}

export function transportReduce(state: TransportState, key: TransportKey): TransportState {
  switch (key) {
    case "L": {
      // Already going forward → faster. Stopped, or going backward → forward 1×.
      if (state.playing && state.rate > 0) {
        return { rate: stepUp(state.rate), playing: true };
      }
      return { rate: RATE_LADDER[0]!, playing: true };
    }
    case "J": {
      if (state.playing && state.rate < 0) {
        return { rate: -stepUp(-state.rate), playing: true };
      }
      return { rate: -RATE_LADDER[0]!, playing: true };
    }
    case "K": {
      // Stop/play toggle that always lands on 1× forward — K is the "settle
      // down" key after a J/L sprint in either direction.
      return { rate: RATE_LADDER[0]!, playing: !state.playing };
    }
  }
}
