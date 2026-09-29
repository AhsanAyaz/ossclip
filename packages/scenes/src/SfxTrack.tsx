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
 * BOUNDED Sequences (2026-09-18). These carried no duration at all — "an
 * effect plays for its own length" — which is true of the SOUND and false of
 * the tag: an unbounded Sequence keeps its `<Audio>` mounted to the end of the
 * composition, so the mounted count climbed with the playhead until the
 * editor's Player ran out of shared audio tags and the error boundary ate the
 * whole stage (`SFX_FALLBACK_DURATION_SEC` has the field report). The length
 * comes from the pack's `durationSec`, and cues still overlap the
 * composition's end — `visibleSfxCues` clamps there, the same truncation
 * Remotion would have done at the last frame.
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
          durationInFrames={cue.durationInFrames}
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
