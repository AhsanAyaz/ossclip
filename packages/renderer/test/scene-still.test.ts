import { describe, expect, it } from "vitest";
import { SceneCueSchema, defaultTheme } from "@ossclip/core/browser";
import {
  STILL_ASPECTS,
  STILL_TAIL_SEC,
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

  it("refuses props no planner could produce, by fixture name", () => {
    const bad = { ...stat("long", [1]), props: { label: "X", value: "1234567890123" } };
    expect(() => stillJobs([bad], defaultTheme, "#000")).toThrow(/StatCard\/long/);
    expect(() => stillJobs([stat("none", [])], defaultTheme, "#000")).toThrow(/no atSec/);
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
