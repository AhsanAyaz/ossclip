import React from "react";
import type { z } from "zod/v4";
import { OffthreadVideo, staticFile } from "remotion";
import type { ClipSceneProps, Theme } from "@ossclip/core/browser";
import { clipVolume } from "../clip-scene";

/**
 * A transparent clip made elsewhere, placed by a script's `clip:` cue
 * (explainer spec 1.4). `src` is the VP9-alpha WebM the CLI's clip import
 * wrote, relative to the render's public dir, so it resolves through
 * `staticFile()` exactly like ScreenshotFrame's side image; an http(s) URL
 * passes through the same way, since `staticFile()` throws on one.
 *
 * `transparent` makes the render extract frames as PNG with their alpha, so
 * the speaker shows through wherever the clip is empty. In the editor's
 * Player, `OffthreadVideo` falls back to a plain `<video>`, which plays VP9
 * alpha natively — one file serves both.
 *
 * Sized to the box SceneLayer hands it and letterboxed with `contain`: the
 * clip was framed by whoever made it, and `cover` would crop that framing
 * (the same reason `--source-fit contain` exists). It is self-fitting in
 * fit.ts, so the box is the slot itself, unscaled. No `data-edit-id`: a clip
 * has no text to edit, and its props (`muted`, `speed`) are reached through the
 * Inspector's schema-derived controls instead.
 */
export const ClipScene: React.FC<{
  props: z.infer<typeof ClipSceneProps>;
  theme: Theme;
  widthPx?: number;
  heightPx?: number;
}> = ({ props, widthPx, heightPx }) => {
  const src = /^https?:\/\//.test(props.src) ? props.src : staticFile(props.src);
  return (
    <OffthreadVideo
      src={src}
      transparent
      volume={clipVolume(props.gainDb, props.muted)}
      // The scene's window is `durationSec / speed` (`fixedDurationSec`), so
      // at this rate the clip's last frame lands on the window's end. Cue
      // props reach SceneLayer unparsed: a cue saved before `speed` existed
      // passes undefined, which Remotion plays at 1x.
      //
      // No window can now reach past the clip's end except by frame rounding:
      // a block is capped at its played length everywhere it is decided
      // (`maxCueSec` in core — the pin read, the editor's drag, the live
      // retime), and only trimmed shorter. Should a window still outrun the
      // file by a frame, the render holds the clip's last frame, and nothing
      // here does it: measured 2026-11-20 on real `production` stills, a 4 s
      // frame-numbered VP9-alpha clip in a 5 s window at 1x showed F60 at 2 s in and F119 (its last) at 4.4 s,
      // and at 2x in a 4 s window F60 at 1 s in and F119 at 3 s — the
      // compositor answers a time past the file's end with its last frame.
      // The editor's `<video>` fallback holds as well: seeked or played past
      // the end, the element sits `ended` at 4.0 s showing F119 until the
      // window closes. No `<Freeze>`, so the hold costs nothing; if a
      // Remotion upgrade ever shows black or loops past the end, that is
      // where it goes.
      playbackRate={props.speed}
      style={{
        display: "block",
        width: widthPx ?? "100%",
        height: heightPx ?? "100%",
        objectFit: "contain",
      }}
    />
  );
};
