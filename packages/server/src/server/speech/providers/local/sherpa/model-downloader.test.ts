import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import {
  ensureSherpaOnnxModel,
  extractTarArchive,
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

  test("extracts a real archive with the platform's tar", async () => {
    // The digest-mismatch test never reaches tar, so it could not catch an
    // unportable invocation. An earlier revision passed --no-absolute-names,
    // which bsdtar (macOS) and GNU tar 1.35 both reject, breaking every fresh
    // model install. This runs whatever tar the platform actually ships.
    const stageRoot = makeTmpDir();
    const stageDir = path.join(stageRoot, "kokoro-en-v0_19");
    mkdirSync(path.join(stageDir, "espeak-ng-data"), { recursive: true });
    for (const file of ["model.onnx", "voices.bin", "tokens.txt"]) {
      writeFileSync(path.join(stageDir, file), `stub ${file}`);
    }

    const archivePath = path.join(makeTmpDir(), "kokoro-en-v0_19.tar.bz2");
    execFileSync("tar", ["cjf", archivePath, "-C", stageRoot, "kokoro-en-v0_19"]);

    const destDir = makeTmpDir();
    await extractTarArchive(archivePath, destDir);

    const extracted = path.join(destDir, "kokoro-en-v0_19");
    expect(existsSync(path.join(extracted, "model.onnx"))).toBe(true);
    expect(existsSync(path.join(extracted, "voices.bin"))).toBe(true);
    expect(existsSync(path.join(extracted, "espeak-ng-data"))).toBe(true);
  });

  test("keeps a traversing archive inside the destination", async () => {
    // tar strips leading `/` and `../` from member names by default, which is
    // why the extract invocation carries no hardening flags.
    const stageRoot = makeTmpDir();
    writeFileSync(path.join(stageRoot, "escape.txt"), "nope");

    const archivePath = path.join(makeTmpDir(), "traversal.tar.bz2");
    execFileSync("tar", ["cjf", archivePath, "-C", stageRoot, "../" + path.basename(stageRoot)], {
      cwd: stageRoot,
    });

    const destDir = makeTmpDir();
    await extractTarArchive(archivePath, destDir);

    const escaped = path.join(path.dirname(destDir), "escape.txt");
    expect(existsSync(escaped)).toBe(false);
  });

  test("every catalog entry pins a sha256", () => {
    for (const [modelId, spec] of Object.entries(SHERPA_ONNX_MODEL_CATALOG)) {
      expect(spec.archiveSha256, modelId).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
