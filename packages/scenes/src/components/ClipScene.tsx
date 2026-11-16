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
 * has no text to edit, and its props (`muted`) are reached through the
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
      style={{
        display: "block",
        width: widthPx ?? "100%",
        height: heightPx ?? "100%",
        objectFit: "contain",
      }}
    />
  );
};
