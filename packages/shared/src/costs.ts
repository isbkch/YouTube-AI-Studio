import type { Usage } from "./index.ts";

/**
 * Cost estimation for recorded `Usage` rows. Every billed provider call
 * persists a `Usage` row (provider, model, and the billed quantities), so
 * pricing is a pure post-traversal: no provider code needs a price table, and
 * rows recorded before a pricing change re-price against the current table.
 *
 * Prices are best-effort list prices (checked September 2026) and produce
 * estimates, not invoices. A model without a pricing rule costs `null` —
 * summaries count it as unpriced instead of silently reporting $0. Local
 * engines (mock, whisper.cpp, Blender, FFmpeg) are genuinely free.
 */
export interface CostLine {
  agent: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
  images: number;
  costUSD: number;
  /** Calls in this line the table could not price. */
  unpricedCalls: number;
}
export interface CostSummary {
  totalUSD: number;
  calls: number;
  /** Billed calls with no pricing rule — the total may under-count. */
  unpricedCalls: number;
  /** Local/mock calls that cost nothing. */
  freeCalls: number;
  /** Priced spend grouped by agent+provider+model, most expensive first. */
  lines: CostLine[];
  lastCallAt: string | null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** $ per 1M tokens, mirroring the published input/output split. */
const per1M = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;

interface PricingRule {
  provider: string | "*";
  pattern: RegExp;
  /** The pricing assumption, for display next to estimates. */
  note: string;
  estimate: (u: Usage) => number | null;
}

/**
 * First match wins; audio and image models are listed before the broader
 * text-model prefixes so `gpt-4o-transcribe` never reads as `gpt-4o`.
 */
export const PRICING_RULES: PricingRule[] = [
  {
    provider: "*",
    pattern: /deterministic/,
    note: "Local deterministic engine — no API cost.",
    estimate: () => 0,
  },
  {
    provider: "mock",
    pattern: /.*/,
    note: "Local mock engine — no API cost.",
    estimate: () => 0,
  },
  {
    provider: "whisper.cpp",
    pattern: /.*/,
    note: "Local whisper.cpp — no API cost.",
    estimate: () => 0,
  },
  {
    provider: "openai",
    pattern: /^(whisper-1|gpt-4o-transcribe|gpt-transcribe)$/,
    note: "$0.006 per audio minute (list transcription rate).",
    estimate: (u) =>
      u.audioSeconds > 0 ? round6(u.audioSeconds * 0.0001) : null,
  },
  {
    provider: "openai",
    pattern: /^gpt-image-1-mini$/,
    note: "$1/$10 per 1M input/output tokens; ≈$0.011 per image fallback.",
    estimate: imagePricing(1, 10, 0.011),
  },
  {
    provider: "openai",
    pattern: /^gpt-image/,
    note: "$5/$40 per 1M input/output tokens; ≈$0.06 per medium image fallback.",
    estimate: imagePricing(5, 40, 0.06),
  },
  {
    provider: "gemini",
    pattern: /image/,
    note: "≈$0.04 per still (≈1,290 output tokens × $30/1M, Flash Image class).",
    estimate: (u) => (u.imageCount > 0 ? round6(u.imageCount * 0.04) : null),
  },
  {
    provider: "gemini",
    pattern: /lyria/i,
    note: "Lyria pricing is unpublished; ≈$0.03 per 30 s clip (estimated).",
    estimate: (u) =>
      u.audioSeconds > 0 ? round6(u.audioSeconds * 0.001) : null,
  },
  {
    provider: "openai",
    pattern: /^gpt-5/,
    note: "$1.25/$10 per 1M input/output tokens (GPT-5 class).",
    estimate: tokenPricing(1.25, 10),
  },
  {
    provider: "openai",
    pattern: /^gpt-4.1/,
    note: "$2/$8 per 1M input/output tokens.",
    estimate: tokenPricing(2, 8),
  },
  {
    provider: "openai",
    pattern: /^gpt-4o/,
    note: "$2.50/$10 per 1M input/output tokens.",
    estimate: tokenPricing(2.5, 10),
  },
];

function tokenPricing(inputPer1M: number, outputPer1M: number) {
  return (u: Usage) =>
    u.inputTokens || u.outputTokens
      ? round6(
          per1M(u.inputTokens, inputPer1M) + per1M(u.outputTokens, outputPer1M),
        )
      : null;
}
/** Images bill per picture; token usage refines the flat per-image estimate. */
function imagePricing(
  inputPer1M: number,
  outputPer1M: number,
  perImage: number,
) {
  return (u: Usage) => {
    if (u.inputTokens || u.outputTokens)
      return round6(
        per1M(u.inputTokens, inputPer1M) + per1M(u.outputTokens, outputPer1M),
      );
    return u.imageCount > 0 ? round6(u.imageCount * perImage) : null;
  };
}

/**
 * The estimated cost of one usage row: rows already carrying a number keep it
 * (local engines record 0), rows with a matching rule price against the
 * current table, and anything else is unpriced (`null`).
 */
export function estimateUsageCost(u: Usage): number | null {
  if (typeof u.costUSD === "number") return u.costUSD;
  const rule = PRICING_RULES.find(
    (r) =>
      (r.provider === "*" || r.provider === u.provider) &&
      r.pattern.test(u.model),
  );
  return rule ? rule.estimate(u) : null;
}

/** Aggregate usage rows into a priced, grouped summary for UI and CLI. */
export function costSummary(usages: Usage[]): CostSummary {
  const groups = new Map<string, CostLine>();
  let unpricedCalls = 0;
  let freeCalls = 0;
  let lastCallAt: string | null = null;
  for (const u of usages) {
    const key = `${u.agent}|${u.provider}|${u.model}`;
    let line = groups.get(key);
    if (!line) {
      line = {
        agent: u.agent,
        provider: u.provider,
        model: u.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 0,
        images: 0,
        costUSD: 0,
        unpricedCalls: 0,
      };
      groups.set(key, line);
    }
    line.calls += 1;
    line.inputTokens += u.inputTokens;
    line.outputTokens += u.outputTokens;
    line.audioSeconds += u.audioSeconds;
    line.images += u.imageCount;
    const cost = estimateUsageCost(u);
    if (cost === null) {
      line.unpricedCalls += 1;
      unpricedCalls += 1;
    } else {
      line.costUSD = round6(line.costUSD + cost);
      if (cost === 0) freeCalls += 1;
    }
    if (!lastCallAt || u.createdAt > lastCallAt) lastCallAt = u.createdAt;
  }
  const lines = [...groups.values()].sort(
    (a, b) => b.costUSD - a.costUSD || b.calls - a.calls,
  );
  return {
    totalUSD: round6(lines.reduce((n, l) => n + l.costUSD, 0)),
    calls: usages.length,
    unpricedCalls,
    freeCalls,
    lines,
    lastCallAt,
  };
}
