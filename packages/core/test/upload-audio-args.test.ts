import { describe, expect, it } from "vitest";
import { REMOTE_UPLOAD_MAX_BYTES, uploadAudioArgs } from "../src/ingest";

/**
 * The remote-upload sidecar (2026-09-01). Pinned as an EXACT array, the
 * whisperArgs posture: the codec and bitrate are the whole decision — the PCM
 * wav is 1.92MB/min and hits Groq's 25MB cap at ~13 minutes, opus at 32k is
 * ~240KB/min and reaches ~100 — so a silent edit here would quietly shrink
 * the longest video anyone can transcribe remotely.
 */
describe("uploadAudioArgs", () => {
  it("encodes ogg/opus 32kbps 16kHz mono, video dropped", () => {
    expect(uploadAudioArgs("/w/audio.wav", "/w/audio-upload.ogg")).toEqual([
      "-y",
      "-i",
      "/w/audio.wav",
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-ar",
      "16000",
      "-ac",
      "1",
      "/w/audio-upload.ogg",
    ]);
  });
});

describe("REMOTE_UPLOAD_MAX_BYTES", () => {
  it("is 24MiB — margin under Groq's 25MB cap so a boundary file fails with OUR message", () => {
    // Must sit under Groq's cap in BOTH readings of "25MB": decimal
    // 25,000,000 and 25 MiB. 24 MiB (25,165,824) fails the first.
    expect(REMOTE_UPLOAD_MAX_BYTES).toBe(24_000_000);
    expect(REMOTE_UPLOAD_MAX_BYTES).toBeLessThan(25_000_000);
  });
});
