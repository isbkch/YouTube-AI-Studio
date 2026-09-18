import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  OpenAIProvider,
  PackagingAgent,
  ResearchAgent,
} from "../packages/agents/src/index.ts";
import {
  GeminiImageProvider,
  OpenAIImageProvider,
} from "../packages/image-engine/src/index.ts";
import {
  buildMusicPrompt,
  GeminiMusicProvider,
} from "../packages/music-engine/src/index.ts";
import { defaultCreator } from "../packages/shared/src/index.ts";

/** Minimal Gemini Interactions API response carrying one generated block. */
const geminiResponse = (block: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      id: "resp_gemini",
      steps: [{ type: "model_output", content: [block] }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

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
test("OpenAI wire schema strips unsupported string formats (uri) but keeps strict allowlisted ones", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAIProvider("test-key-not-a-secret", "gpt-5.4", {
    fetch: async (_url, options) => {
      body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          id: "resp_uri",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              id: "msg_uri",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: '{"home":"https://example.com/adr","at":"2026-09-18T00:00:00Z"}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await provider.generateStructured({
    name: "uri_notes",
    schema: z.strictObject({ home: z.url(), at: z.iso.datetime() }),
    instructions: "Return one URL and one timestamp.",
    input: { topic: "uris" },
  });
  const properties = (
    body.text as {
      format: {
        schema: {
          properties: Record<string, { type: string; format?: string }>;
        };
      };
    }
  ).format.schema.properties;
  assert.equal(properties.home.type, "string");
  assert.equal("format" in properties.home, false);
  assert.equal(properties.at.format, "date-time");
  assert.equal(result.output.home, "https://example.com/adr");
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

test("Gemini image adapter rides the Interactions API and maps sizes to aspect ratios", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const provider = new GeminiImageProvider("gemini-test-key", {
    model: "gemini-3.1-flash-image",
    fetch: async (request, options) => {
      url = String(request);
      headers = Object.fromEntries(
        new Headers((options as RequestInit | undefined)?.headers),
      );
      body = JSON.parse(String(options?.body));
      return geminiResponse({
        type: "image",
        data: Buffer.from("gemini-png-bytes").toString("base64"),
        mime_type: "image/png",
      });
    },
  });
  const result = await provider.generate({
    prompt: "A quiet datacenter corridor, no text",
    size: "1536x1024",
    quality: "high",
  });
  assert.ok(url.endsWith("/v1beta/interactions"));
  assert.equal(headers["x-goog-api-key"], "gemini-test-key");
  assert.equal(body.model, "gemini-3.1-flash-image");
  const format = body.response_format as {
    type: string;
    aspect_ratio: string;
    image_size: string;
  };
  assert.equal(format.type, "image");
  assert.equal(format.aspect_ratio, "3:2");
  assert.equal(format.image_size, "2K");
  assert.equal(result.data.toString(), "gemini-png-bytes");
  assert.equal(result.usage.provider, "gemini");
  assert.equal(result.usage.imageCount, 1);
  assert.equal(result.usage.agent, "image_generation");
});

test("Gemini image adapter surfaces empty payloads as retryable failures", async () => {
  const provider = new GeminiImageProvider("gemini-test-key", {
    fetch: async () => geminiResponse({ type: "text", text: "no image" }),
  });
  await assert.rejects(
    provider.generate({
      prompt: "The model answered in prose",
      size: "1024x1024",
      quality: "low",
    }),
    /no image data/,
  );
});

test("Gemini music adapter requests Lyria clips and returns audio bytes with trusted wording", async () => {
  let body: Record<string, unknown> = {};
  const provider = new GeminiMusicProvider("gemini-test-key", {
    model: "lyria-3-clip-preview",
    fetch: async (_request, options) => {
      body = JSON.parse(String(options?.body));
      return geminiResponse({
        type: "audio",
        data: Buffer.from("mp3-bytes").toString("base64"),
      });
    },
  });
  const result = await provider.generate({
    prompt: buildMusicPrompt({
      brief: "Calm instrumental bed for a technical explainer, warm pads.",
    }),
  });
  assert.equal(body.model, "lyria-3-clip-preview");
  const input = body.input as { type: string; text: string }[];
  assert.equal(input[0].type, "text");
  assert.match(input[0].text, /Instrumental background music only/);
  assert.equal(result.data.toString(), "mp3-bytes");
  assert.equal(result.usage.agent, "music_generation");
  assert.equal(result.usage.provider, "gemini");
  assert.equal(result.usage.audioSeconds, 30);
});

test("Gemini providers refuse to construct without credentials", () => {
  assert.throws(() => new GeminiImageProvider("  "), /Gemini credentials/);
  assert.throws(() => new GeminiMusicProvider(""), /Gemini credentials/);
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

test("pre-production research agent rides the strict structured transport", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAIProvider("test-key", "gpt-5.4", {
    fetch: async (_url, options) => {
      body = JSON.parse(String(options?.body));
      const output = {
        schemaVersion: "1.0.0",
        summary: "Brief from model knowledge.",
        keyPoints: [
          { text: "Point one.", sourceUrls: ["https://sre.google/books/"] },
        ],
        claims: [],
        counterpoints: [],
        openQuestions: [],
        sources: [
          {
            url: "https://sre.google/books/",
            title: "Site Reliability Engineering",
          },
        ],
      };
      return new Response(
        JSON.stringify({
          id: "resp_research",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              id: "msg_research",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(output),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 210, output_tokens: 60, total_tokens: 270 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await new ResearchAgent(provider).research({
    projectId: "project-test",
    idea: "Why multi-region failover still fails",
    creator: defaultCreator,
    targetDuration: 600,
  });
  assert.equal(
    (body.text as { format: { name: string } }).format.name,
    "research_notes",
  );
  const input = JSON.parse(String(body.input)) as { idea: string };
  assert.equal(input.idea, "Why multi-region failover still fails");
  assert.equal(result.output.schemaVersion, "1.0.0");
  assert.equal(result.output.keyPoints.length, 1);
  assert.equal(result.usage.agent, "research_notes");
  assert.equal(result.usage.inputTokens, 210);
});

test("packaging agent rides the strict structured transport with the fixed timeline", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAIProvider("test-key", "gpt-5.4", {
    fetch: async (_url, options) => {
      body = JSON.parse(String(options?.body));
      const output = {
        schemaVersion: "1.0.0",
        titleCandidates: [
          { title: "Own what you generate", angle: "a", why: "b" },
          { title: "The cost of generated code", angle: "a", why: "b" },
          { title: "Cheap code, expensive systems", angle: "a", why: "b" },
        ],
        recommendedTitleIndex: 2,
        thumbnailConcepts: [
          {
            id: "thumb-1",
            headline: "IT WORKS.",
            direction: "Green checkmark turning red behind the presenter.",
            emotionalHook: "Irony",
          },
          {
            id: "thumb-2",
            headline: "WHO OWNS IT?",
            direction: "Concerned face toward a laptop.",
            emotionalHook: "Worry",
          },
        ],
        description: {
          opening: "Generated code is cheap; owning it is not.",
          body: ["What the video covers and who it is for."],
          sources: [{ url: "https://sre.google/books/", title: "SRE" }],
        },
        chapters: [
          { seconds: 0, title: "The trap" },
          { seconds: 10, title: "The failure" },
        ],
        metadata: {
          tags: ["reliability", "ai"],
          categoryId: "28",
          visibility: "private",
          language: "en",
          madeForKids: false,
        },
        notes: [],
      };
      return new Response(
        JSON.stringify({
          id: "resp_packaging",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              id: "msg_packaging",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(output),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 400, output_tokens: 120, total_tokens: 520 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await new PackagingAgent(provider).package({
    projectId: "project-test",
    videoTitle: "Not production ready",
    thesis: "Generated code is cheap; owning it is not.",
    chapters: [
      { seconds: 0, title: "The trap" },
      { seconds: 10, title: "The failure" },
    ],
    finalSeconds: 30,
    sources: [],
    creator: defaultCreator,
  });
  assert.equal(
    (body.text as { format: { name: string } }).format.name,
    "video_packaging",
  );
  const input = JSON.parse(String(body.input)) as {
    chapters: { seconds: number }[];
  };
  assert.deepEqual(
    input.chapters.map((c) => c.seconds),
    [0, 10],
  );
  assert.equal(
    result.output.titleCandidates[2].title,
    "Cheap code, expensive systems",
  );
  assert.equal(result.usage.agent, "video_packaging");
  assert.equal(result.usage.inputTokens, 400);
});
