import { describe, expect, it } from "vitest";
import { SceneCueSchema, defaultTheme } from "@ossclip/core/browser";
import {
  STAND_IN_FACE,
  STILL_ASPECTS,
  STILL_TAIL_SEC,
  standInGeometry,
  standInSvg,
  selectStillFixtures,
  stillCue,
  stillFileName,
  stillFrame,
  stillJobs,
  type StillFixture,
} from "../src/scene-still";
import { STILL_FIXTURES } from "../../scenes/test/stills.fixtures";

const stat = (name: string, atSec: number[]): StillFixture => ({
  component: "StatCard",
  name,
  props: { label: "STARS", value: "4,494" },
  atSec,
});

describe("stillJobs", () => {
  it("draws each fixture in both aspects at every atSec, through a real cue", () => {
    const jobs = stillJobs([stat("a", [0.5, 1.5])], defaultTheme, "#000000");
    expect(jobs.map((j) => j.fileName)).toEqual([
      "StatCard-a-16x9-0.5s.png",
      "StatCard-a-16x9-1.5s.png",
      "StatCard-a-9x16-0.5s.png",
      "StatCard-a-9x16-1.5s.png",
    ]);
    expect(jobs[0]!.props.frame).toEqual(STILL_ASPECTS["16x9"]);
    expect(jobs[2]!.props.frame).toEqual(STILL_ASPECTS["9x16"]);
    // One duration per fixture: the latest still plus the tail, so no still
    // lands in the exit fade.
    for (const j of jobs) expect(j.props.durationSec).toBe(1.5 + STILL_TAIL_SEC);
  });

  it("fills registry defaults and the default layout", () => {
    const [job] = stillJobs([stat("a", [1])], defaultTheme, "#000000");
    expect(job!.props.props).toMatchObject({ inverted: false });
    expect(job!.props.layout).toBe("video-top");
    const [moved] = stillJobs([{ ...stat("b", [1]), layout: "full-bleed" }], defaultTheme, "#000");
    expect(moved!.props.layout).toBe("full-bleed");
  });

  it("carries a fixture's graphicRect onto the still's cue, and none when the fixture has none (§161)", () => {
    const rect = { x: 0.14, y: 0.16, w: 0.72, h: 0.68 };
    const [placed] = stillJobs([{ ...stat("p", [1]), layout: "full-bleed", graphicRect: rect }], defaultTheme, "#000");
    expect(placed!.props.graphicRect).toEqual(rect);
    expect(stillCue(placed!.props)).toMatchObject({ layout: "full-bleed", graphicRect: rect });
    expect(SceneCueSchema.safeParse(stillCue(placed!.props)).success).toBe(true);
    const [plain] = stillJobs([stat("a", [1])], defaultTheme, "#000");
    expect("graphicRect" in plain!.props).toBe(false);
    expect("graphicRect" in stillCue(plain!.props)).toBe(false);
  });

  it("a fixture may name the aspects it is drawn in; absent, it is drawn in both", () => {
    const jobs = stillJobs([{ ...stat("wide", [1]), aspects: ["16x9"] }], defaultTheme, "#000");
    expect(jobs.map((j) => j.fileName)).toEqual(["StatCard-wide-16x9-1s.png"]);
  });

  it("refuses props no planner could produce, by fixture name", () => {
    const bad = { ...stat("long", [1]), props: { label: "X", value: "1234567890123" } };
    expect(() => stillJobs([bad], defaultTheme, "#000")).toThrow(/StatCard\/long/);
    expect(() => stillJobs([stat("none", [])], defaultTheme, "#000")).toThrow(/no atSec/);
  });
});

describe("backdrop fixtures: a stand-in speaker under the scene (§163)", () => {
  it("solid draws graphic-only and bubble draws pip-bubble, each with the default stand-in face", () => {
    const [solid] = stillJobs([{ ...stat("s", [1]), backdrop: "solid" }], defaultTheme, "#000");
    expect(solid!.props.layout).toBe("graphic-only");
    expect(solid!.props.backdrop).toBe("solid");
    expect(solid!.props.face).toEqual(STAND_IN_FACE);
    const [bubble] = stillJobs([{ ...stat("b", [1]), backdrop: "bubble" }], defaultTheme, "#000");
    expect(bubble!.props.layout).toBe("pip-bubble");
    expect(bubble!.props.backdrop).toBe("bubble");
    expect(stillCue(bubble!.props)).toMatchObject({ layout: "pip-bubble" });
    expect(SceneCueSchema.safeParse(stillCue(bubble!.props)).success).toBe(true);
  });

  it("the default face is centre x 0.52, centre y 0.38, size 0.3 of a 16:9 source", () => {
    expect(STAND_IN_FACE).toEqual({ centerXFrac: 0.52, centerYFrac: 0.38, sizeFrac: 0.3, sourceAspect: 16 / 9 });
  });

  it("a fixture's own face position replaces the default", () => {
    const face = { centerXFrac: 0.3, centerYFrac: 0.45, sizeFrac: 0.2 };
    const [job] = stillJobs([{ ...stat("f", [1]), backdrop: "bubble", face }], defaultTheme, "#000");
    expect(job!.props.face).toEqual({ ...face, sourceAspect: 16 / 9 });
  });

  it("speaker, or no backdrop, adds nothing: the props are exactly today's", () => {
    for (const f of [stat("a", [1]), { ...stat("a", [1]), backdrop: "speaker" as const }]) {
      const [job] = stillJobs([f], defaultTheme, "#000");
      expect("backdrop" in job!.props).toBe(false);
      expect("face" in job!.props).toBe(false);
      expect(job!.props.layout).toBe("video-top");
    }
  });

  it("refuses a fixture whose layout contradicts its backdrop", () => {
    expect(() =>
      stillJobs([{ ...stat("x", [1]), backdrop: "bubble", layout: "full-bleed" }], defaultTheme, "#000"),
    ).toThrow(/StatCard\/x/);
    // Agreeing is fine.
    expect(() =>
      stillJobs([{ ...stat("y", [1]), backdrop: "solid", layout: "graphic-only" }], defaultTheme, "#000"),
    ).not.toThrow();
  });

  it("the stand-in is a 1920x1080 grey frame with a lighter head ellipse at the face", () => {
    const g = standInGeometry(STAND_IN_FACE);
    expect(g.width).toBe(1920);
    expect(g.height).toBe(1080);
    expect(g.cx).toBeCloseTo(0.52 * 1920, 9);
    expect(g.cy).toBeCloseTo(0.38 * 1080, 9);
    // Head-sized: as tall as the face box (0.3 of the height), a little
    // narrower than tall.
    expect(2 * g.ry).toBeCloseTo(0.3 * 1080, 9);
    expect(g.rx).toBeLessThan(g.ry);
    const svg = standInSvg(STAND_IN_FACE);
    expect(svg).toContain('viewBox="0 0 1920 1080"');
    expect(svg).toContain("<ellipse");
  });
});

describe("stillCue", () => {
  it("is a valid graphic cue starting at 0 and running the whole still", () => {
    const [job] = stillJobs([stat("a", [1])], defaultTheme, "#000000");
    const cue = stillCue(job!.props);
    expect(SceneCueSchema.safeParse(cue).success).toBe(true);
    expect(cue).toMatchObject({ kind: "graphic", component: "StatCard", startSec: 0, endSec: 3 });
  });
});

describe("stillFrame and stillFileName", () => {
  it("photographs the frame at atSec", () => {
    expect(stillFrame(1.5)).toBe(45);
    expect(stillFrame(0)).toBe(0);
    expect(stillFrame(1, 60)).toBe(60);
  });

  it("names files <Component>-<name>-<aspect>-<atSec>s.png", () => {
    expect(stillFileName({ component: "StatCard", name: "dense" }, "9x16", 0.35)).toBe(
      "StatCard-dense-9x16-0.35s.png",
    );
  });
});

describe("selectStillFixtures", () => {
  const fixtures: StillFixture[] = [stat("a", [1]), { ...stat("b", [1]), component: "RuleCard" }];

  it("renders everything with no argument, one component's fixtures with one", () => {
    expect(selectStillFixtures(fixtures, undefined)).toHaveLength(2);
    expect(selectStillFixtures(fixtures, "RuleCard").map((f) => f.name)).toEqual(["b"]);
  });

  it("refuses a typo, or a component without fixtures, listing the valid names", () => {
    expect(() => selectStillFixtures(fixtures, "Statcard")).toThrow(
      /unknown component "Statcard" — fixtures exist for: StatCard, RuleCard/,
    );
    expect(() => selectStillFixtures(fixtures, "TitleCard")).toThrow(/fixtures exist for/);
  });
});

describe("STILL_FIXTURES", () => {
  // The committed fixtures must survive the same parse the script does, so a
  // registry change that breaks one fails here rather than at `pnpm stills`.
  it("all parse against their registry schemas", () => {
    expect(() => stillJobs(STILL_FIXTURES, defaultTheme, defaultTheme.bg)).not.toThrow();
    expect(STILL_FIXTURES.length).toBeGreaterThan(0);
  });
});
