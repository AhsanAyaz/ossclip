import { describe, expect, it } from "vitest";
import { RATE_LADDER, transportReduce, type TransportState } from "../src/transport";

const stopped: TransportState = { rate: 1, playing: false };

describe("J/K/L transport reducer (PLAN Task 2)", () => {
  it("L from stopped plays forward at 1x; repeated L climbs the ladder and holds at the top", () => {
    let s = transportReduce(stopped, "L");
    expect(s).toEqual({ rate: 1, playing: true });
    const seen = [s.rate];
    for (let i = 0; i < 5; i++) {
      s = transportReduce(s, "L");
      seen.push(s.rate);
    }
    expect(seen).toEqual([1, 1.5, 2, 4, 4, 4]);
  });

  it("J mirrors L into negative rates", () => {
    let s = transportReduce(stopped, "J");
    expect(s).toEqual({ rate: -1, playing: true });
    s = transportReduce(s, "J");
    expect(s.rate).toBe(-1.5);
    s = transportReduce(s, "J");
    expect(s.rate).toBe(-2);
  });

  it("L while reversing snaps to forward 1x, and J mirrors — no ladder carry-over", () => {
    expect(transportReduce({ rate: -4, playing: true }, "L")).toEqual({ rate: 1, playing: true });
    expect(transportReduce({ rate: 4, playing: true }, "J")).toEqual({ rate: -1, playing: true });
  });

  it("K toggles stop/play and always lands on 1x forward", () => {
    expect(transportReduce({ rate: 4, playing: true }, "K")).toEqual({ rate: 1, playing: false });
    expect(transportReduce({ rate: -2, playing: false }, "K")).toEqual({ rate: 1, playing: true });
  });

  it("the ladder starts at 1 — K's reset and L's first press agree by construction", () => {
    expect(RATE_LADDER[0]).toBe(1);
  });
});
