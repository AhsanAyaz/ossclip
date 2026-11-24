import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  approvedClipScenes,
  clipKey,
  productionStoryboardOf,
  shotLengthSec,
  shotSceneId,
  shotSpokenLine,
  type ClipKeyParts,
} from "../src/storyboard/approval";
import { StoryboardSchema, type ShotApproval, type Storyboard, type StoryboardShot } from "../src/storyboard/record";
import { ProductionSchema } from "../src/schema";

/**
 * The approval record and the pure rules around it (storyboard design §8,
 * §9; plan B2a Task 1; §169): which shots become clip scenes, what
 * production.json records for them, the length a shot is rendered at, and
 * the key that says when a clip must be rendered again.
 */

function approval(over: Partial<ShotApproval> = {}): ShotApproval {
  return {
    version: 2,
    durationSec: 4.5,
    clipKey: "k1",
    clip: "storyboard/s1/approved.mov",
    src: "clips/0123456789ab.webm",
    ...over,
  };
}

function shot(over: Partial<StoryboardShot> = {}): StoryboardShot {
  return {
    id: "s1",
    startWord: 3,
    endWord: 9,
    idea: "a goldfish swims in and blows a bubble",
    why: "the speaker names the goldfish here",
    priority: 1,
    assets: [],
    kept: true,
    origin: "planner",
    touched: false,
    ...over,
  };
}

function board(shots: StoryboardShot[]): Storyboard {
  return { version: 1, nextShot: shots.length + 1, shots };
}

const A = shot({ id: "a", startWord: 10, endWord: 14, approval: approval({ clip: "storyboard/a/approved.mov", src: "clips/aaa.webm", durationSec: 3.6 }) });
const B = shot({ id: "b", startWord: 20, endWord: 25 });
const C = shot({ id: "c", startWord: 30, endWord: 35, kept: false, approval: approval({ clip: "storyboard/c/approved.mov", src: "clips/ccc.webm" }) });

describe("approvedClipScenes", () => {
  it("one ClipScene per shot that is kept AND approved", () => {
    const scenes = approvedClipScenes(board([A, B, C]));
    expect(scenes).toHaveLength(1);
    const [s] = scenes;
    expect(s!.id).toBe(shotSceneId("a"));
    expect(s!.id).toBe("shot-a");
    expect(s!.component).toBe("ClipScene");
    expect(s!.layout).toBe("full-bleed");
    expect(s!.anchor).toEqual({ startWord: 10, endWord: 14 });
    expect(s!.props).toEqual({ src: "clips/aaa.webm", durationSec: 3.6, muted: true });
    expect(s!.overrides).toEqual({});
    expect(s!.rationale).toBe("storyboard shot a");
  });

  it("comes out in startWord order whatever the row order", () => {
    const D = shot({ id: "d", startWord: 2, endWord: 5, approval: approval({ src: "clips/ddd.webm" }) });
    expect(approvedClipScenes(board([A, D])).map((s) => s.id)).toEqual(["shot-d", "shot-a"]);
  });

  it("no approved kept shot gives no scene", () => {
    expect(approvedClipScenes(board([B, C]))).toEqual([]);
  });
});

describe("productionStoryboardOf", () => {
  it("records the same shots as approvedClipScenes", () => {
    expect(productionStoryboardOf(board([A, B, C]))).toEqual({
      shots: [{ id: "a", startWord: 10, endWord: 14, clip: "storyboard/a/approved.mov", src: "clips/aaa.webm", durationSec: 3.6 }],
    });
  });

  it("is undefined when no kept shot is approved", () => {
    expect(productionStoryboardOf(board([B, C]))).toBeUndefined();
    expect(productionStoryboardOf(board([]))).toBeUndefined();
  });
});

describe("shotLengthSec", () => {
  const span = { startWord: 0, endWord: 1 };

  it("runs from the first kept word's start to the last kept word's end", () => {
    expect(shotLengthSec(span, [{ start: 10.0, end: 10.4 }, { start: 13.1, end: 13.6 }])).toBe(3.6);
  });

  it("is never shorter than the shortest shot", () => {
    expect(shotLengthSec(span, [{ start: 1, end: 1.2 }, { start: 1.3, end: 1.5 }])).toBe(2);
  });

  it("is never longer than a scene may last", () => {
    expect(shotLengthSec(span, [{ start: 0, end: 1 }, { start: 19, end: 20 }])).toBe(15);
  });

  it("skips a cut word, and a cut first or last word moves the edge inward", () => {
    const at = [{ start: 4, end: 4.5 }, null, { start: 7, end: 7.25 }];
    expect(shotLengthSec({ startWord: 0, endWord: 2 }, at)).toBe(3.25);
    expect(shotLengthSec({ startWord: 0, endWord: 3 }, [null, { start: 4, end: 4.5 }, { start: 7, end: 7.25 }, null])).toBe(3.25);
  });

  it("reads only the shot's own words", () => {
    const at = [{ start: 0, end: 1 }, { start: 2, end: 2.5 }, { start: 4, end: 5 }, { start: 30, end: 31 }];
    expect(shotLengthSec({ startWord: 1, endWord: 2 }, at)).toBe(3);
  });

  it("is null when every word of the shot is cut", () => {
    expect(shotLengthSec(span, [null, null])).toBeNull();
  });
});

describe("shotSpokenLine", () => {
  it("joins the kept words of the shot by one space, skipping cut ones", () => {
    const words = [{ text: "before" }, { text: "the" }, { text: "um" }, { text: "goldfish" }, { text: "swims" }, { text: "after" }];
    expect(shotSpokenLine({ startWord: 1, endWord: 4 }, words, (i) => i !== 2)).toBe("the goldfish swims");
  });
});

describe("clipKey", () => {
  const sha1 = (t: string) => createHash("sha1").update(t).digest("hex");
  const base: ClipKeyParts = {
    code: "export default () => null;",
    kitVersion: 1,
    theme: { bg: "#000", accent: "#FFE14D", radiusPx: 24 },
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 4.5,
  };
  const key = (over: Partial<ClipKeyParts>) => clipKey({ ...base, ...over }, sha1);

  it("is the same for a theme whose keys come in another order", () => {
    expect(key({ theme: { radiusPx: 24, accent: "#FFE14D", bg: "#000" } })).toBe(key({}));
  });

  it("is a non-empty string from the hash it is given", () => {
    expect(key({})).toMatch(/^[0-9a-f]{40}$/);
  });

  it("changes with the code", () => expect(key({ code: "export default () => 1;" })).not.toBe(key({})));
  it("changes with the kit version", () => expect(key({ kitVersion: 2 })).not.toBe(key({})));
  it("changes with a theme value", () => expect(key({ theme: { ...(base.theme as object), accent: "#FF0000" } })).not.toBe(key({})));
  it("changes with the width", () => expect(key({ width: 1920 })).not.toBe(key({})));
  it("changes with the height", () => expect(key({ height: 1080 })).not.toBe(key({})));
  it("changes with the frame rate", () => expect(key({ fps: 60 })).not.toBe(key({})));
  it("changes with the length", () => expect(key({ durationSec: 4.6 })).not.toBe(key({})));
});

describe("StoryboardSchema approval", () => {
  it("parses a B1 shot with no approval, and adds none", () => {
    const parsed = StoryboardSchema.parse(board([shot()]));
    expect("approval" in parsed.shots[0]!).toBe(false);
  });

  it("round-trips a shot with an approval", () => {
    const sb = board([shot({ approval: approval() })]);
    expect(StoryboardSchema.parse(JSON.parse(JSON.stringify(sb)))).toEqual(sb);
  });

  it("refuses an approval with no length", () => {
    expect(() => StoryboardSchema.parse(board([shot({ approval: approval({ durationSec: 0 }) })]))).toThrow();
  });
});

describe("ProductionSchema.storyboard", () => {
  const bareProduction = {
    version: 1,
    source: {
      path: "/takes/raw.mp4",
      probe: { duration: 12, width: 1080, height: 1920, fps: 30, hasAudio: true },
    },
    cleanup: "standard",
    render: { width: 1080, height: 1920, fps: 30 },
  };

  it("parses a production with no storyboard, and adds none", () => {
    expect("storyboard" in ProductionSchema.parse(bareProduction)).toBe(false);
  });

  it("round-trips a storyboard record", () => {
    const storyboard = {
      shots: [{ id: "s1", startWord: 3, endWord: 9, clip: "storyboard/s1/approved.mov", src: "clips/0123456789ab.webm", durationSec: 4.5 }],
    };
    expect(ProductionSchema.parse({ ...bareProduction, storyboard }).storyboard).toEqual(storyboard);
  });
});
