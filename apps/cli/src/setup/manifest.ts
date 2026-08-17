/**
 * The acquisition table `ossclip setup` provisions from — pure data.
 *
 * Every entry is pinned to an exact upstream release and checksum, verified
 * at pin time; setup refuses a download whose hash doesn't match. Nothing
 * here ships inside the npm package — the GPL ffmpeg builds and the
 * whisper.cpp binaries are downloaded onto the user's machine at the user's
 * request, which keeps the MIT package's dependency graph clean.
 *
 * Bumping a pin: update url/version/sha256 together (BtbN publishes
 * `checksums.sha256` per release; ggml-org assets are hashed by hand), and
 * re-run the setup-e2e workflow. The manifest test asserts every supported
 * platform×arch resolves to either an asset or an explicit manual hint.
 */

import { basename, isAbsolute, join } from "node:path";
import { z } from "zod/v4";

export interface BinaryAsset {
  url: string;
  sha256: string;
  /** Extracted with `tar -xf` everywhere; win32 falls back to Expand-Archive for zips. */
  archive: "zip" | "tar.gz" | "tar.xz";
  /** Binary basenames to locate (recursively) after extraction. */
  bins: string[];
  /** Download size, for up-front disclosure. */
  sizeMB: number;
  license: "GPL" | "MIT";
  version: string;
}

const BTBN =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-29-13-36";
const FFMPEG_VER = "n8.1.2-31-g8c9502e9b0";

const WHISPER =
  "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1";
const WHISPER_VER = "v1.9.1";

/**
 * Static ffmpeg+ffprobe per platform. macOS returns null: BtbN publishes no
 * darwin assets, and brew is near-universal there — the planner falls back
 * to it.
 */
export function ffmpegAsset(platform: NodeJS.Platform, arch: string): BinaryAsset | null {
  const bins =
    platform === "win32" ? ["ffmpeg.exe", "ffprobe.exe"] : ["ffmpeg", "ffprobe"];
  const common = { bins, license: "GPL" as const, version: FFMPEG_VER };
  if (platform === "win32" && arch === "x64") {
    return {
      ...common,
      url: `${BTBN}/ffmpeg-${FFMPEG_VER}-win64-gpl-8.1.zip`,
      sha256: "106d3f8e72b70e29f83983dbaa65efdfc5355716a5df675dc846e441929f7890",
      archive: "zip",
      sizeMB: 160,
    };
  }
  if (platform === "win32" && arch === "arm64") {
    return {
      ...common,
      url: `${BTBN}/ffmpeg-${FFMPEG_VER}-winarm64-gpl-8.1.zip`,
      sha256: "ac46bdb0c9c619b107c7281a0cc6932a9419c4d6c3c8c36a259550f7fcee1a1a",
      archive: "zip",
      sizeMB: 107,
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      ...common,
      url: `${BTBN}/ffmpeg-${FFMPEG_VER}-linux64-gpl-8.1.tar.xz`,
      sha256: "9fb60ff01e6574258dc76efdf94f901a651582da67b8edcfd10e8860233b7ef4",
      archive: "tar.xz",
      sizeMB: 120,
    };
  }
  if (platform === "linux" && arch === "arm64") {
    return {
      ...common,
      url: `${BTBN}/ffmpeg-${FFMPEG_VER}-linuxarm64-gpl-8.1.tar.xz`,
      sha256: "d8f9598a885db3deabd06af7f0f70c8565af27d29fadbcf746598c9306a0c3fa",
      archive: "tar.xz",
      sizeMB: 102,
    };
  }
  return null;
}

/**
 * Prebuilt whisper.cpp `whisper-cli` per platform. The Windows zip carries
 * its DLLs beside the exe and the Ubuntu tarballs link their .so files via
 * an `$ORIGIN` runpath, so both run straight out of the extracted directory
 * (verified at pin time). macOS returns null — upstream ships no darwin CLI
 * binary; brew's `whisper-cpp` covers it.
 *
 * Windows-on-ARM gets the x64 build: upstream publishes no arm64 zip, and
 * Windows 11 runs x64 binaries under emulation.
 */
export function whisperAsset(platform: NodeJS.Platform, arch: string): BinaryAsset | null {
  if (platform === "win32") {
    // The BLAS build — meaningfully faster on small.en, worth the extra DLL.
    return {
      url: `${WHISPER}/whisper-blas-bin-x64.zip`,
      sha256: "3c319eab3e87f85883e1ff3d14426c0a1986c661c5eb5985e8af431ed9c4f71f",
      archive: "zip",
      bins: ["whisper-cli.exe"],
      sizeMB: 20,
      license: "MIT",
      version: WHISPER_VER,
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      url: `${WHISPER}/whisper-bin-ubuntu-x64.tar.gz`,
      sha256: "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
      archive: "tar.gz",
      bins: ["whisper-cli"],
      sizeMB: 9,
      license: "MIT",
      version: WHISPER_VER,
    };
  }
  if (platform === "linux" && arch === "arm64") {
    return {
      url: `${WHISPER}/whisper-bin-ubuntu-arm64.tar.gz`,
      sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
      archive: "tar.gz",
      bins: ["whisper-cli"],
      sizeMB: 5,
      license: "MIT",
      version: WHISPER_VER,
    };
  }
  return null;
}

/**
 * ggml transcription models. Sizes and SHA-1 hashes come from upstream's
 * models/README.md — upstream publishes SHA-1, so that's what we verify;
 * it's an integrity check against truncated downloads, not a security
 * boundary (the download is already pinned to a host and path over HTTPS).
 *
 * Curated fine-tunes ride the same table: `url` points at their own host
 * (ggerganov's mirror only carries the stock models — the old hardcoded URL
 * 404'd for every custom name, and the suggested `curl -L` then saved the
 * 404 HTML as a fake model), and `language` records what the fine-tune
 * decodes so produce can imply `-l` when nothing else sets one (an Urdu
 * fine-tune without `-l ur` silently decodes English garbage — Urdu field
 * test 2026-08-05).
 */
export interface ModelInfo {
  sizeMB?: number;
  sha1?: string;
  /** Direct download URL for models the ggerganov mirror doesn't host. */
  url?: string;
  /** The language the fine-tune decodes — implied `-l` when neither flag nor config sets one. */
  language?: string;
  /** Provenance, printed by setup at download time and shown as the wizard hint. */
  note?: string;
}

export const MODELS: Record<string, ModelInfo> = {
  "tiny.en": { sizeMB: 75, sha1: "c78c86eb1a8faa21b369bcd33207cc90d64ae9df" },
  "base.en": { sizeMB: 142, sha1: "137c40403d78fd54d454da0f9bd998f78703390c" },
  "small.en": { sizeMB: 466, sha1: "db8a495a91d927739e50b3fc1cc4c6b8f6c2d022" },
  "medium.en": { sizeMB: 1536, sha1: "8c30f0e44ce9560643ebd10bbe50cd20eafd3723" },
  // URL pending the author's upload (2026-08-17) — sha1 added when the file
  // is published; setup already warns-and-continues without a checksum.
  "medium-urdu": {
    sizeMB: 1463,
    // sha1 computed 2026-08-17 from the author's converted file BEFORE the HF
    // upload — same bytes, so the pin is valid the moment the file publishes,
    // and a corrupted/tampered mirror download fails the checksum loudly.
    sha1: "59769d590f62eeeb3bc3f5b82ce8c03b6e96831e",
    language: "ur",
    note: "community Urdu fine-tune (Abdul145/whisper-medium-urdu-custom, Apache-2.0), converted to GGML",
    url: "https://huggingface.co/CodeWithAhsan/whisper-medium-urdu-ggml/resolve/main/ggml-medium-urdu.bin",
  },
};

/**
 * A model pick reduced to its bare name: basename, minus the optional ggml-
 * prefix and .bin suffix. Exists because classifying on the raw value
 * misreads paths — an absolute /x/ggml-small.en.bin ends in ".bin", so the
 * wizard's `.endsWith(".en")` language heuristic prefilled `auto` for an
 * ENGLISH model (review fix, Urdu field test 2026-08-05) — and the MODELS
 * lookups below must find `medium-urdu` inside either spelling.
 */
export function bareWhisperModelName(nameOrPath: string): string {
  const base = basename(nameOrPath);
  const m = /^(?:ggml-)?(.+?)(?:\.bin)?$/.exec(base);
  return m?.[1] ?? base;
}

/**
 * The language a model pick implies when the user set none: the curated
 * table's `language`, keyed on the bare name so `--whisper-model medium-urdu`
 * and an absolute /x/ggml-medium-urdu.bin both resolve it. Undefined for
 * stock models and unknown fine-tunes — whisper's own en default stands.
 */
export function modelImpliedLanguage(nameOrPath: string): string | undefined {
  return MODELS[bareWhisperModelName(nameOrPath)]?.language;
}

/**
 * THE model-download URL — the single source produce's missing-model error,
 * doctor's fix line, and setup's download all read (they used to hold string
 * dupes of the ggerganov URL, which 404'd for any custom name). Precedence:
 * the config's `modelSources` entry (a user's own fine-tune is one config
 * line) > the curated table's `url` > the ggerganov default mirror.
 */
export function modelUrl(name: string, sources?: Record<string, string>): string {
  return (
    sources?.[name] ??
    MODELS[name]?.url ??
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`
  );
}

/**
 * The one model-path resolution rule, extracted from its three duplicated
 * sites (produce's transcription step, doctor's model check, setup's plan):
 * an absolute model is a file path used verbatim, a bare name lives in
 * modelDir as ggml-<name>.bin.
 */
export function whisperModelPath(model: string, modelDir: string): string {
  return isAbsolute(model) ? model : join(modelDir, `ggml-${model}.bin`);
}

/**
 * Consumer-side vetting for the config's `modelSources` key — the
 * `validDictionary` posture (produce.ts) applied to a record: the value
 * comes from a hand-editable JSON file loadConfig doesn't zod-parse, so a
 * non-object, a non-string URL, or a URL that trims to nothing means the
 * whole key is ignored (`undefined`) and the call site warns once.
 * All-or-nothing on purpose: half a typo'd map would download some models
 * from a source the user never reviewed.
 */
export function validModelSources(value: unknown): Record<string, string> | undefined {
  const parsed = z.record(z.string(), z.string().trim().min(1)).safeParse(value);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return undefined;
  return parsed.data;
}

/** The exact build recipe printed when no prebuilt fits — one copy, not four. */
export const WHISPER_BUILD_HINT =
  "build whisper.cpp from source: git clone https://github.com/ggml-org/whisper.cpp && " +
  "cd whisper.cpp && cmake -B build && cmake --build build -j --config Release " +
  "(then point OSSCLIP_WHISPER at build/bin/whisper-cli)";
