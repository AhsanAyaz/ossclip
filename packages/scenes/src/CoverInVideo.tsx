import React from "react";
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import {
  coverInVideoFrames,
  coverInVideoOpacity,
  type CoverInVideoProps,
} from "./cover-in-video";

/** The overlay's own frame — inside the Sequence, so frame 0 is frame 1 of
 * the video and the fade math (cover-in-video.ts) reads the local clock. */
const CoverImage: React.FC<{ cover: CoverInVideoProps; durationInFrames: number }> = ({
  cover,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        // Black behind the image, not transparent: the cover is rendered at
        // the OUTPUT frame's exact size (produce renders it from `frame`), but
        // an image that ever disagrees must letterbox against the same black
        // the composition's own backdrop uses rather than flash the video
        // through the margins.
        backgroundColor: "black",
        opacity: coverInVideoOpacity(frame, durationInFrames),
      }}
    >
      <Img
        // An http(s) URL passes through untouched, everything else is a name
        // in the render's public dir — CoverComposition's exact rule, and the
        // one that also lets the editor hand this component a `/media/…` URL
        // (staticFile leaves an already-rooted path alone).
        src={/^https?:\/\//.test(cover.fileName) ? cover.fileName : staticFile(cover.fileName)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};

/**
 * `--cover-in-video`: the cover image over the short's first frames (see
 * cover-in-video.ts for the overlay-not-insertion argument and the window
 * bounds). Mounted ABOVE everything — video, scenes, captions, watermark —
 * because a cover with a caption burned through it is not a cover.
 *
 * Deliberately invisible to the editor, the Watermark's rule for the same
 * reason: no `data-edit-id`/`data-edit-scene` so hitTest.ts can never resolve
 * it as a selection, and `pointerEvents: none` so a click at frame 0 falls
 * through to whatever the overlay covers. It is a produce-time switch, not a
 * scene element.
 */
export const CoverInVideo: React.FC<{ cover: CoverInVideoProps }> = ({ cover }) => {
  const { fps } = useVideoConfig();
  const { from, durationInFrames } = coverInVideoFrames(cover.durationSec, fps);
  return (
    <Sequence from={from} durationInFrames={durationInFrames} layout="none">
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <CoverImage cover={cover} durationInFrames={durationInFrames} />
      </AbsoluteFill>
    </Sequence>
  );
};
