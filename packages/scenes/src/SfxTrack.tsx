import React from "react";
import { Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { visibleSfxCues, type SfxCueProps } from "./sfx-track";

/**
 * The `--sfx` sound-effect track: one `<Sequence>` per cue, each mounting an
 * `<Audio>` at its own instant.
 *
 * MIXED INSIDE REMOTION ON PURPOSE, and this is the whole reason the feature
 * is cheap: the render's audio goes through loudnorm afterwards (core's
 * ingest.ts), so a mix done here is MEASURED as part of the programme — the
 * effects sit at a level normalized against the speech instead of being
 * stamped on after the loudness pass, which is what a post-render ffmpeg
 * overlay would have meant (and would have needed its own gain staging to
 * avoid clipping the take it lands on).
 *
 * No duration on the Sequences: an effect plays for its own length. That is
 * also why cues can overlap the composition's own end — Remotion truncates the
 * tail at the last frame, and a whoosh clipped by the end of the video is the
 * same thing an editor would do by hand.
 *
 * Deliberately invisible to the editor, the Watermark/CoverInVideo rule: no
 * `data-edit-id`, nothing to hit-test, nothing rendered at all. Placement
 * editing arrives through the overrides doc, not through the stage.
 */
export const SfxTrack: React.FC<{ cues: readonly SfxCueProps[] }> = ({ cues }) => {
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <>
      {visibleSfxCues(cues, fps, durationInFrames).map((cue, i) => (
        <Sequence
          // Index in the VISIBLE list plus the frame: two effects can share a
          // frame (different sounds, same beat), so neither alone is a stable
          // key, and React would remount one of them on any list change.
          key={`${cue.from}-${i}`}
          from={cue.from}
          layout="none"
        >
          <Audio
            // An http(s) URL (or the editor's `/media/…`) passes through
            // untouched, everything else is a name in the render's public dir
            // — CoverInVideo's exact rule.
            src={/^https?:\/\//.test(cue.soundFile) ? cue.soundFile : staticFile(cue.soundFile)}
            volume={cue.gain}
          />
        </Sequence>
      ))}
    </>
  );
};
