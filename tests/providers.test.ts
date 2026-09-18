import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultProviderSelection,
  Store,
} from "../packages/orchestrator/src/store.ts";
import {
  applyProviderSelection,
  configuredImageProvider,
  type ProviderCredentials,
} from "../packages/orchestrator/src/providers.ts";
import { MockMusicProvider } from "../packages/music-engine/src/index.ts";
import type { Studio } from "../packages/orchestrator/src/studio.ts";

const noCredentials: ProviderCredentials = {
  openAI: "",
  gemini: "",
  openAISource: "none",
  geminiSource: "none",
};
const stub = () => ({}) as unknown as Studio;

test("image-only setup reports missing credentials without requiring Director credentials", () => {
  for (const images of ["openai", "gemini"] as const)
    assert.throws(
      () => configuredImageProvider({ images, imageModel: "" }, noCredentials),
      /credentials/i,
    );
  assert.equal(
    configuredImageProvider({ images: "mock", imageModel: "" }, noCredentials)
      .model,
    "deterministic-v1",
  );
});

test("provider selections persist in the settings store and tolerate partial rows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-providers-"));
  try {
    const store = new Store(root);
    assert.deepEqual(store.providerSelection(), defaultProviderSelection());
    store.setProviderSelection({
      ...defaultProviderSelection(),
      director: "openai",
      images: "gemini",
      music: "mock",
      imageModel: "gemini-3-pro-image",
    });
    const selection = store.providerSelection();
    assert.equal(selection.director, "openai");
    assert.equal(selection.images, "gemini");
    assert.equal(selection.music, "mock");
    assert.equal(selection.imageModel, "gemini-3-pro-image");
    // Unknown fields or bad enum values fall back to defaults, never crash.
    store.db
      .prepare(
        "INSERT INTO settings VALUES('providers',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify({ images: "midjourney", music: "mock" }));
    assert.deepEqual(store.providerSelection(), {
      ...defaultProviderSelection(),
      music: "mock",
    });
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applying a selection wires the requested engines and honors model overrides", () => {
  const studio = stub();
  const applied = applyProviderSelection(
    studio,
    {
      ...defaultProviderSelection(),
      images: "openai",
      music: "mock",
      imageModel: "gpt-image-1-mini",
    },
    { ...noCredentials, openAI: "sk-test", openAISource: "env" },
  );
  assert.equal(applied.images, "openai");
  assert.equal(applied.imageModel, "gpt-image-1-mini");
  assert.equal(applied.music, "mock");
  assert.ok(studio.music instanceof MockMusicProvider);
  assert.equal(studio.music.model, "deterministic-v1");
  assert.equal(applied.openAICredentialSource, "env");
});

test("library music leaves the generation engine unset; billed engines fail closed without keys", () => {
  const studio = stub();
  const applied = applyProviderSelection(
    studio,
    defaultProviderSelection(),
    noCredentials,
  );
  assert.equal(applied.music, "library");
  assert.equal(studio.music, null);
  assert.equal(applied.images, "mock");

  // Strict mode (Settings "Apply"): a billed engine without its credential is
  // an actionable configuration error, not a silent downgrade.
  for (const selection of [
    { ...defaultProviderSelection(), images: "gemini" as const },
    { ...defaultProviderSelection(), images: "openai" as const },
    { ...defaultProviderSelection(), music: "gemini" as const },
  ])
    assert.throws(
      () => applyProviderSelection(stub(), selection, noCredentials),
      /credentials/i,
    );

  // Lenient mode (runtime startup): free engines keep the library usable.
  const lenient = applyProviderSelection(
    stub(),
    { ...defaultProviderSelection(), music: "gemini" },
    noCredentials,
    { lenient: true },
  );
  assert.equal(lenient.music, "library");
  assert.equal(lenient.images, "mock");
});
