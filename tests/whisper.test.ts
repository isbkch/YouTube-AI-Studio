import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureWhisperModel,
  WhisperCLIProvider,
} from "../packages/agents/src/whisper.ts";
import { StudioError } from "../packages/shared/src/index.ts";

const modelBytes = (seed: number) => {
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i * 7) % 251;
  return bytes;
};

/** Fake huggingface.co: paths-info metadata plus the model download itself. */
function hub(
  bytes: Uint8Array,
  options: {
    oid?: string;
    size?: number;
    downloadStatus?: number;
    metadataStatus?: number;
  } = {},
) {
  const calls: string[] = [];
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fetch = (async (url: string | URL | RequestInfo) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/paths-info/main")) {
      if (options.metadataStatus && options.metadataStatus !== 200)
        return new Response("gone", { status: options.metadataStatus });
      const size = options.size ?? bytes.byteLength;
      return new Response(
        JSON.stringify([
          {
            type: "file",
            path: "ggml-small.bin",
            size,
            lfs: { oid: options.oid ?? sha256, size },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (href.endsWith("/resolve/main/ggml-small.bin")) {
      if (options.downloadStatus && options.downloadStatus !== 200)
        return new Response("not found", { status: options.downloadStatus });
      return new Response(Buffer.from(bytes), { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const tempModelPath = async () =>
  path.join(
    await mkdtemp(path.join(tmpdir(), "wts-whisper-")),
    "ggml-small.bin",
  );

test("ensureWhisperModel downloads a missing canonical model, verifies it, and never refetches", async () => {
  const modelPath = await tempModelPath();
  const bytes = modelBytes(1);
  const { fetch, calls } = hub(bytes);
  const resolved = await ensureWhisperModel({
    modelPath,
    transport: { fetch },
  });
  assert.equal(resolved, modelPath);
  assert.deepEqual(new Uint8Array(await readFile(modelPath)), bytes);
  assert.equal(
    (await readdir(path.dirname(modelPath))).filter((f) => f.endsWith(".part"))
      .length,
    0,
    "partial files must be promoted, not left behind",
  );
  assert.equal(
    calls.filter((c) => c.endsWith("/resolve/main/ggml-small.bin")).length,
    1,
  );
  calls.length = 0;
  await ensureWhisperModel({ modelPath, transport: { fetch } });
  assert.equal(calls.length, 0, "an existing model must not be re-downloaded");
});

test("ensureWhisperModel falls back to size checking when hub metadata is unavailable", async () => {
  const modelPath = await tempModelPath();
  const bytes = modelBytes(2);
  const { fetch } = hub(bytes, { metadataStatus: 404 });
  await ensureWhisperModel({ modelPath, transport: { fetch } });
  assert.deepEqual(new Uint8Array(await readFile(modelPath)), bytes);
});

test("ensureWhisperModel rejects truncated downloads and cleans up the partial file", async () => {
  const modelPath = await tempModelPath();
  const bytes = modelBytes(3);
  const { fetch } = hub(bytes, { size: bytes.byteLength + 1 });
  await assert.rejects(
    ensureWhisperModel({ modelPath, transport: { fetch } }),
    (e: unknown) =>
      e instanceof StudioError &&
      e.kind === "EXTERNAL_TOOL" &&
      /Incomplete download/.test(e.message),
  );
  assert.equal(
    (await readdir(path.dirname(modelPath))).length,
    0,
    "failed downloads must leave no file behind",
  );
});

test("ensureWhisperModel rejects checksum mismatches and cleans up the partial file", async () => {
  const modelPath = await tempModelPath();
  const { fetch } = hub(modelBytes(4), {
    oid: "0".repeat(64),
  });
  await assert.rejects(
    ensureWhisperModel({ modelPath, transport: { fetch } }),
    (e: unknown) =>
      e instanceof StudioError &&
      e.kind === "EXTERNAL_TOOL" &&
      /checksum/.test(e.message),
  );
  assert.equal((await readdir(path.dirname(modelPath))).length, 0);
});

test("ensureWhisperModel keeps custom model names manual and offline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wts-whisper-"));
  const { fetch, calls } = hub(modelBytes(5));
  await assert.rejects(
    ensureWhisperModel({
      modelPath: path.join(dir, "my-finetuned-model.bin"),
      transport: { fetch },
    }),
    (e: unknown) => e instanceof StudioError && e.kind === "MISSING_DEPENDENCY",
  );
  assert.equal(calls.length, 0, "unknown names must not hit the network");
});

test("ensureWhisperModel reports unpublished model names clearly", async () => {
  const modelPath = await tempModelPath();
  const { fetch } = hub(modelBytes(6), { downloadStatus: 404 });
  await assert.rejects(
    ensureWhisperModel({ modelPath, transport: { fetch } }),
    (e: unknown) =>
      e instanceof StudioError &&
      e.kind === "MISSING_DEPENDENCY" &&
      /No whisper.cpp model named/.test(e.message),
  );
  assert.equal((await readdir(path.dirname(modelPath))).length, 0);
});

test("concurrent ensureWhisperModel calls share a single download", async () => {
  const modelPath = await tempModelPath();
  const bytes = modelBytes(7);
  const { fetch, calls } = hub(bytes);
  const [, second] = await Promise.all([
    ensureWhisperModel({ modelPath, transport: { fetch } }),
    ensureWhisperModel({ modelPath, transport: { fetch } }),
  ]);
  assert.equal(second, modelPath);
  assert.deepEqual(new Uint8Array(await readFile(modelPath)), bytes);
  assert.equal(
    calls.filter((c) => c.endsWith("/resolve/main/ggml-small.bin")).length,
    1,
  );
});

test("WhisperCLIProvider exposes the local model identity it will ensure", async () => {
  const provider = new WhisperCLIProvider("/tmp/wts-test/ggml-small.bin");
  assert.equal(provider.name, "whisper");
  assert.equal(provider.modelPath, "/tmp/wts-test/ggml-small.bin");
});
