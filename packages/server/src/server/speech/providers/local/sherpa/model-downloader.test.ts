import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import {
  ensureSherpaOnnxModel,
  getSherpaOnnxModelDir,
  ModelArchiveIntegrityError,
} from "./model-downloader.js";
import { getSherpaOnnxModelSpec, SHERPA_ONNX_MODEL_CATALOG } from "./model-catalog.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-speech-models-"));
}

const logger = pino({ level: "silent" });

describe("sherpa model downloader", () => {
  test("getSherpaOnnxModelDir maps modelId to extractedDir", () => {
    const modelsDir = "/tmp/models";
    expect(getSherpaOnnxModelDir(modelsDir, "parakeet-tdt-0.6b-v2-int8")).toContain(
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    );
    expect(getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19")).toContain("kokoro-en-v0_19");
  });

  test("ensureSherpaOnnxModel succeeds without downloading when files exist", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19");

    mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
    writeFileSync(path.join(modelDir, "model.onnx"), "x");
    writeFileSync(path.join(modelDir, "voices.bin"), "x");
    writeFileSync(path.join(modelDir, "tokens.txt"), "x");

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "kokoro-en-v0_19",
      logger,
    });

    expect(out).toBe(modelDir);
  });

  test("rejects a tampered archive before extracting it and discards the file", async () => {
    const modelsDir = makeTmpDir();
    const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
    const archivePath = path.join(
      modelsDir,
      ".downloads",
      path.basename(new URL(spec.archiveUrl).pathname),
    );

    // Stand in for a substituted or corrupted download: a pre-existing archive
    // short-circuits the fetch, so this reaches the digest check without any
    // network access.
    mkdirSync(path.dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, "not the model you pinned");

    await expect(
      ensureSherpaOnnxModel({ modelsDir, modelId: "kokoro-en-v0_19", logger }),
    ).rejects.toThrow(ModelArchiveIntegrityError);

    // Left on disk it would short-circuit the fetch again and never be re-downloaded.
    expect(existsSync(archivePath)).toBe(false);
    // Nothing was unpacked.
    expect(existsSync(getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19"))).toBe(false);
  });

  test("every catalog entry pins a sha256", () => {
    for (const [modelId, spec] of Object.entries(SHERPA_ONNX_MODEL_CATALOG)) {
      expect(spec.archiveSha256, modelId).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
