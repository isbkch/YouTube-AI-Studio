import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { OpenAIProvider } from "../packages/agents/src/index.ts";
import { OpenAIImageProvider } from "../packages/image-engine/src/index.ts";

test("OpenAI adapter uses Responses strict structured output and records usage without a network call", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAIProvider("test-key-not-a-secret", "gpt-5.4", {
    fetch: async (_url, options) => {
      body = JSON.parse(String(options?.body));
      return new Response(
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
                  text: '{"summary":"Use a diagram."}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await provider.generateStructured({
    name: "director_note",
    schema: z.strictObject({ summary: z.string() }),
    instructions: "Return an editorial summary.",
    input: { narration: "A request crosses a dependency." },
  });
  assert.equal(body.store, false);
  const format = (
    body.text as {
      format: {
        type: string;
        strict: boolean;
        schema: { additionalProperties: boolean };
      };
    }
  ).format;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  assert.equal(result.output.summary, "Use a diagram.");
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.usage.costUSD, null);
});
test("OpenAI refusals are surfaced as actionable failures, never executed as prose", async () => {
  const provider = new OpenAIProvider("test", "gpt-5.4", {
    fetch: async () =>
      new Response(
        JSON.stringify({
          id: "resp_refused",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              id: "msg_refused",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "refusal", refusal: "Cannot comply." }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    provider.generateStructured({
      name: "result",
      schema: z.strictObject({ text: z.string() }),
      instructions: "Return JSON.",
      input: {},
    }),
    /incomplete or refused/,
  );
});

test("OpenAI image adapter sends gpt-image-1 parameters and records imageCount", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const provider = new OpenAIImageProvider("test-key", {
    fetch: async (request, options) => {
      url = String(request);
      body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await provider.generate({
    prompt: "A quiet datacenter corridor, no text",
    size: "1536x1024",
    quality: "medium",
  });
  assert.ok(url.endsWith("/images/generations"));
  assert.equal(body.model, "gpt-image-1");
  assert.equal(body.size, "1536x1024");
  assert.equal(body.quality, "medium");
  assert.equal(body.n, 1);
  assert.equal(result.data.toString(), "png-bytes");
  assert.equal(result.usage.imageCount, 1);
  assert.equal(result.usage.agent, "image_generation");
});
test("OpenAI image adapter refuses empty image payloads as retryable", async () => {
  const provider = new OpenAIImageProvider("test-key", {
    fetch: async () =>
      new Response(JSON.stringify({ created: 1, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    provider.generate({
      prompt: "An empty response follows",
      size: "1536x1024",
      quality: "low",
    }),
    /no image data/,
  );
});
test("vision review attaches labeled frames as multimodal input", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAIProvider("test-key-not-a-secret", "gpt-5.4", {
    fetch: async (_url, options) => {
      body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          id: "resp_vision",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              id: "msg_vision",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: '{"scenes":[{"sceneId":"scene-1","verdict":"pass","findings":[]}],"summary":"OK."}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 900, output_tokens: 9, total_tokens: 909 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  // A 1x1 red PNG is enough to prove the data URL plumbing.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const frame = path.join(
    await mkdtemp(path.join(os.tmpdir(), "wts-vision-")),
    "frame.jpg",
  );
  await writeFile(frame, png);
  const result = await provider.generateStructured({
    name: "visual_qa",
    schema: z.strictObject({
      summary: z.string(),
      scenes: z.array(
        z.strictObject({
          sceneId: z.string(),
          verdict: z.string(),
          findings: z.array(z.string()),
        }),
      ),
    }),
    instructions: "Judge the frames.",
    input: { scenes: [{ sceneId: "scene-1" }] },
    images: [{ path: frame, label: "scene-1" }],
  });
  const input = body.input as {
    role: string;
    content: { type: string; text?: string; image_url?: string }[];
  }[];
  assert.equal(input.length, 1);
  assert.equal(input[0].content[0].type, "input_text");
  assert.match(
    input[0].content[1].image_url ?? "",
    /^data:image\/jpeg;base64,/,
  );
  assert.equal(result.output.scenes[0].verdict, "pass");
});
