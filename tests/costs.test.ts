import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  costSummary,
  estimateUsageCost,
} from "../packages/shared/src/costs.ts";
import type { Usage } from "../packages/shared/src/index.ts";
import { OpenAIProvider } from "../packages/agents/src/index.ts";
import { OpenAIImageProvider } from "../packages/image-engine/src/index.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";

const row = (over: Partial<Usage>): Usage => ({
  agent: "storyboard_direction",
  provider: "openai",
  model: "gpt-5.4",
  inputTokens: 0,
  outputTokens: 0,
  audioSeconds: 0,
  imageCount: 0,
  costUSD: null,
  elapsedMs: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  ...over,
});

test("text models price input and output tokens against the current table", () => {
  assert.equal(
    estimateUsageCost(row({ inputTokens: 1_000_000, outputTokens: 500_000 })),
    6.25,
  );
  assert.equal(
    estimateUsageCost(
      row({ model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 250_000 }),
    ),
    5,
  );
  // A chat row without captured tokens cannot be priced honestly.
  assert.equal(estimateUsageCost(row({})), null);
});

test("audio, stills and music each read their own billed quantity", () => {
  assert.equal(
    estimateUsageCost(
      row({ agent: "transcription", model: "whisper-1", audioSeconds: 90 }),
    ),
    0.009,
  );
  assert.equal(
    estimateUsageCost(
      row({
        agent: "transcription",
        model: "gpt-transcribe",
        audioSeconds: 1800,
      }),
    ),
    0.18,
  );
  // Token-reported images refine the estimate; legacy rows fall back per image.
  assert.equal(
    estimateUsageCost(
      row({
        agent: "image_generation",
        model: "gpt-image-1",
        inputTokens: 20,
        outputTokens: 1500,
        imageCount: 1,
      }),
    ),
    0.0601,
  );
  assert.equal(
    estimateUsageCost(
      row({ agent: "image_generation", model: "gpt-image-1", imageCount: 1 }),
    ),
    0.06,
  );
  assert.equal(
    estimateUsageCost(
      row({
        provider: "gemini",
        model: "gemini-3.1-flash-image",
        imageCount: 2,
      }),
    ),
    0.08,
  );
  assert.equal(
    estimateUsageCost(
      row({
        provider: "gemini",
        model: "lyria-3-clip-preview",
        audioSeconds: 30,
      }),
    ),
    0.03,
  );
});

test("local engines are free, custom models stay unpriced, recorded costs win", () => {
  assert.equal(
    estimateUsageCost(row({ provider: "mock", model: "deterministic-v1" })),
    0,
  );
  assert.equal(
    estimateUsageCost(
      row({ provider: "whisper.cpp", model: "large-v3", costUSD: 0 }),
    ),
    0,
  );
  assert.equal(estimateUsageCost(row({ model: "custom-fine-tune" })), null);
  assert.equal(
    estimateUsageCost(
      row({ inputTokens: 1_000_000, outputTokens: 1_000_000, costUSD: 0.5 }),
    ),
    0.5,
  );
});

test("summaries group spend by agent+model and surface unpriced calls", () => {
  const s = costSummary([
    row({
      inputTokens: 200_000,
      outputTokens: 100_000,
      createdAt: "2026-09-18T01:00:00.000Z",
    }),
    row({ inputTokens: 200_000, outputTokens: 100_000 }),
    row({ agent: "transcription", model: "whisper-1", audioSeconds: 60 }),
    row({ agent: "packaging", model: "custom-fine-tune" }),
    row({ provider: "mock", model: "deterministic-v1", costUSD: 0 }),
  ]);
  assert.equal(s.lines.length, 4);
  assert.equal(s.totalUSD, 2.506);
  assert.equal(s.calls, 5);
  assert.equal(s.unpricedCalls, 1);
  assert.equal(s.freeCalls, 1);
  assert.equal(s.lastCallAt, "2026-09-18T01:00:00.000Z");
  assert.equal(s.lines[0].agent, "storyboard_direction");
  assert.equal(s.lines[0].costUSD, 2.5);
  const unpriced = s.lines.find((l) => l.agent === "packaging")!;
  assert.equal(unpriced.costUSD, 0);
  assert.equal(unpriced.unpricedCalls, 1);
});

test("the OpenAI transport prices usage rows at record time", async () => {
  const provider = new OpenAIProvider("test-key-not-a-secret", "gpt-5.4", {
    fetch: async () =>
      new Response(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              id: "msg_test",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: '{"summary":"ok"}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const result = await provider.generateStructured({
    name: "director_note",
    schema: z.strictObject({ summary: z.string() }),
    instructions: "Summarize.",
    input: {},
  });
  assert.equal(result.usage.costUSD, 0.000175);
});

test("the OpenAI image adapter records billed tokens and prices them", async () => {
  const provider = new OpenAIImageProvider("test-key", {
    fetch: async () =>
      new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
          usage: { input_tokens: 20, output_tokens: 1500, total_tokens: 1520 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const result = await provider.generate({
    prompt: "A quiet datacenter corridor, no text",
    size: "1536x1024",
    quality: "medium",
  });
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.outputTokens, 1500);
  assert.equal(result.usage.costUSD, 0.0601);
});

test("snapshots, project lists and cost reports carry priced summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-costs-"));
  const store = new Store(root);
  try {
    const p = store.create("Costs");
    store.update(p.id, (x) => {
      x.usage.push(row({ inputTokens: 200_000, outputTokens: 100_000 }));
      x.usage.push(
        row({ agent: "transcription", model: "whisper-1", audioSeconds: 60 }),
      );
    });
    const studio = new Studio(store);
    assert.equal(studio.snapshot(p.id).costs.totalUSD, 1.256);
    const listed = studio.listProjects();
    assert.equal(listed[0].costs.calls, 2);
    const report = studio.costs(p.id);
    assert.equal(report.project.totalUSD, 1.256);
    assert.equal(report.library.totalUSD, 1.256);
    assert.deepEqual(
      report.productions.map((x) => x.id),
      [p.id],
    );
    // Empty summaries stay well-formed for brand-new projects.
    const fresh = store.create("Fresh");
    assert.equal(studio.costs(fresh.id).project.totalUSD, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
