import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { THUMBNAIL_MODEL_DEFAULT } from "@ossclip/core";
import {
  lastBoolFlag,
  lastFlagValue,
  thumbnailPanelState,
  type ThumbnailPanelInputs,
} from "../src/thumbnail-panel";

// The pure half of the editor thumbnail panel (2026-08-17): the pins × config
// × env matrix, with no server, no filesystem and no real ~/.ossclip.

const exists = (paths: string[]) => (p: string) => paths.includes(p);

/** A "everything configured" baseline the cases below perturb one axis of. */
const ready: ThumbnailPanelInputs = {
  commandArgs: ["produce", "in.mp4", "--youtube", "--portrait", "/p/face.png"],
  cfg: {},
  hasKey: true,
  approvedSkip: false,
  hasConcept: true,
  hasImage: true,
  portraitExists: exists(["/p/face.png"]),
};

describe("lastFlagValue / lastBoolFlag", () => {
  it("takes the LAST occurrence — commander's own rule, so pins beat typed flags", () => {
    const args = ["produce", "--portrait", "/typed.png", "--portrait", "/pinned.png"];
    expect(lastFlagValue(args, ["--portrait"])).toBe("/pinned.png");
    expect(lastBoolFlag(["--no-youtube", "--youtube"], "--youtube", "--no-youtube")).toBe(true);
    expect(lastBoolFlag(["--youtube", "--no-youtube"], "--youtube", "--no-youtube")).toBe(false);
  });

  it("answers undefined when the flag never appears (the config decides)", () => {
    expect(lastFlagValue(["produce", "in.mp4"], ["-o", "--out"])).toBeUndefined();
    expect(lastBoolFlag(["produce"], "--youtube", "--no-youtube")).toBeUndefined();
  });

  it("accepts any spelling from the alias list", () => {
    expect(lastFlagValue(["produce", "-o", "/out.mp4"], ["-o", "--out"])).toBe("/out.mp4");
    expect(lastFlagValue(["produce", "--out", "/out.mp4"], ["-o", "--out"])).toBe("/out.mp4");
  });

  it("a trailing flag with no value is not an occurrence", () => {
    expect(lastFlagValue(["produce", "--portrait"], ["--portrait"])).toBeUndefined();
  });
});

describe("thumbnailPanelState — availability", () => {
  it("everything configured is ready, with the resolved portrait and model", () => {
    expect(thumbnailPanelState(ready)).toEqual({
      status: "ready",
      model: THUMBNAIL_MODEL_DEFAULT,
      portraitPath: "/p/face.png",
      portraitSource: "flag",
    });
  });

  it("a pinned --no-youtube is unavailable/no-youtube, whatever the config says", () => {
    const state = thumbnailPanelState({
      ...ready,
      commandArgs: ["produce", "in.mp4", "--no-youtube"],
      cfg: { youtube: true },
    });
    expect(state.status).toBe("unavailable");
    expect(state.reason).toBe("no-youtube");
  });

  it("with no pin the config decides — and only a literal true counts", () => {
    // resolveYoutube's parse-don't-coerce rule restated: a typo'd
    // `"youtube": "yes"` must not switch a paid pipeline ON. Artifact
    // evidence is excluded here (hasConcept/hasImage false) — with artifacts
    // on disk the 2026-08-17 crash-before-pins rule deliberately reads the
    // gate as satisfied regardless of config (see the field-case describe).
    const noPin = {
      ...ready,
      commandArgs: ["produce", "in.mp4", "--portrait", "/p/face.png"],
      hasConcept: false,
      hasImage: false,
    };
    expect(thumbnailPanelState({ ...noPin, cfg: { youtube: true } }).status).toBe("ready");
    expect(thumbnailPanelState({ ...noPin, cfg: { youtube: "yes" } }).reason).toBe("no-youtube");
    expect(thumbnailPanelState({ ...noPin, cfg: {} }).reason).toBe("no-youtube");
  });

  it("no portrait anywhere → no-portrait; a config portrait fills the gap", () => {
    const args = ["produce", "in.mp4", "--youtube"];
    expect(thumbnailPanelState({ ...ready, commandArgs: args }).reason).toBe("no-portrait");
    const withCfg = thumbnailPanelState({
      ...ready,
      commandArgs: args,
      cfg: { portrait: "/p/face.png" },
    });
    expect(withCfg.status).toBe("ready");
    expect(withCfg.portraitPath).toBe("/p/face.png");
    expect(withCfg.portraitSource).toBe("config");
    // A non-string config portrait is ignored, never coerced.
    expect(
      thumbnailPanelState({ ...ready, commandArgs: args, cfg: { portrait: true } }).reason,
    ).toBe("no-portrait");
  });

  it("a ~/ config portrait expands against home, produce.ts's own treatment", () => {
    const home = homedir();
    const state = thumbnailPanelState({
      ...ready,
      commandArgs: ["produce", "in.mp4", "--youtube"],
      cfg: { portrait: "~/face.png" },
      portraitExists: exists([`${home}/face.png`]),
    });
    expect(state.status).toBe("ready");
    expect(state.portraitPath).toBe(`${home}/face.png`);
  });

  it("no key → no-key; portrait on record but not on disk → portrait-missing", () => {
    expect(thumbnailPanelState({ ...ready, hasKey: false }).reason).toBe("no-key");
    expect(thumbnailPanelState({ ...ready, portraitExists: () => false }).reason).toBe(
      "portrait-missing",
    );
  });

  it("no command.json at all falls back to config alone", () => {
    const state = thumbnailPanelState({
      ...ready,
      commandArgs: null,
      cfg: { youtube: true, portrait: "/p/face.png" },
    });
    expect(state.status).toBe("ready");
  });
});

describe("thumbnailPanelState — skip file, never-generated, model", () => {
  it("a {skip:true} approval reads as skipped/skip-file when generation could run", () => {
    expect(thumbnailPanelState({ ...ready, approvedSkip: true })).toMatchObject({
      status: "skipped",
      reason: "skip-file",
    });
  });

  it("unavailability outranks the skip file — controls that cannot work stay hidden", () => {
    expect(thumbnailPanelState({ ...ready, approvedSkip: true, hasKey: false }).status).toBe(
      "unavailable",
    );
  });

  it("ready with nothing on disk carries never-generated; any artifact clears it", () => {
    expect(
      thumbnailPanelState({ ...ready, hasConcept: false, hasImage: false }).reason,
    ).toBe("never-generated");
    expect(
      thumbnailPanelState({ ...ready, hasConcept: true, hasImage: false }).reason,
    ).toBeUndefined();
    expect(
      thumbnailPanelState({ ...ready, hasConcept: false, hasImage: true }).reason,
    ).toBeUndefined();
  });

  it("config thumbnailModel overrides the default; a non-string is ignored", () => {
    expect(thumbnailPanelState({ ...ready, cfg: { thumbnailModel: "my-image-model" } }).model).toBe(
      "my-image-model",
    );
    expect(thumbnailPanelState({ ...ready, cfg: { thumbnailModel: 42 } }).model).toBe(
      THUMBNAIL_MODEL_DEFAULT,
    );
  });
});

describe("thumbnailPanelState — portrait override (editor face swap, 2026-08-17)", () => {
  const OVERRIDE = "/w/portrait-override.png";

  it("the override beats the pinned flag AND the config — a swapped face survives replays", () => {
    const state = thumbnailPanelState({
      ...ready,
      cfg: { portrait: "/cfg.png" },
      overridePortraitPath: OVERRIDE,
      portraitExists: exists([OVERRIDE, "/p/face.png", "/cfg.png"]),
    });
    expect(state.status).toBe("ready");
    expect(state.portraitPath).toBe(OVERRIDE);
    expect(state.portraitSource).toBe("override");
  });

  it("the override alone satisfies the no-portrait gate", () => {
    const state = thumbnailPanelState({
      ...ready,
      commandArgs: ["produce", "in.mp4", "--youtube"],
      cfg: {},
      overridePortraitPath: OVERRIDE,
      portraitExists: exists([OVERRIDE]),
    });
    expect(state.status).toBe("ready");
    expect(state.portraitPath).toBe(OVERRIDE);
    expect(state.portraitSource).toBe("override");
  });

  it("an override cannot argue with a --no-youtube pin — still unavailable", () => {
    const state = thumbnailPanelState({
      ...ready,
      commandArgs: ["produce", "in.mp4", "--no-youtube"],
      hasConcept: false,
      hasImage: false,
      overridePortraitPath: OVERRIDE,
      portraitExists: exists([OVERRIDE]),
    });
    expect(state.status).toBe("unavailable");
    expect(state.reason).toBe("no-youtube");
  });

  it("an override whose file vanished reads portrait-missing like any portrait", () => {
    const state = thumbnailPanelState({
      ...ready,
      commandArgs: ["produce", "in.mp4", "--youtube"],
      overridePortraitPath: OVERRIDE,
      portraitExists: () => false,
    });
    expect(state.reason).toBe("portrait-missing");
  });
});

describe("artifacts beat flag archaeology (2026-08-17 crash-before-pins field case)", () => {
  // The first wizard run crashed at the output rename BEFORE command.json was
  // written, leaving an approved concept + generated image but no pins. A
  // panel that answers "no-youtube" about a thumbnail sitting right there is
  // lying — artifacts on disk are direct evidence the pack was on.
  const base = {
    commandArgs: null,
    cfg: { portrait: "/p/face.png" },
    hasKey: true,
    approvedSkip: false,
    portraitExists: () => true,
  };
  it("a concept on disk satisfies the youtube gate with no pins and no config", () => {
    const s = thumbnailPanelState({ ...base, hasConcept: true, hasImage: false });
    expect(s.status).toBe("ready");
  });
  it("an image on disk does too", () => {
    const s = thumbnailPanelState({ ...base, hasConcept: false, hasImage: true });
    expect(s.status).toBe("ready");
  });
  it("no artifacts, no pins, no config → still no-youtube", () => {
    const s = thumbnailPanelState({ ...base, hasConcept: false, hasImage: false });
    expect(s.status).toBe("unavailable");
    expect(s.reason).toBe("no-youtube");
  });
  it("an explicit --no-youtube pin still wins over artifacts", () => {
    const s = thumbnailPanelState({
      ...base,
      commandArgs: ["--no-youtube"],
      hasConcept: true,
      hasImage: true,
    });
    expect(s.status).toBe("unavailable");
    expect(s.reason).toBe("no-youtube");
  });
});
