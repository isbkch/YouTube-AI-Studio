import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { OpenAIProvider } from "../packages/agents/src/index.ts";

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
