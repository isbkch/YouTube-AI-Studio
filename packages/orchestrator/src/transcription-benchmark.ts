import { z } from "zod";
import { speechTokens } from "../../agents/src/gpt-transcription.ts";
import type { Transcript } from "./model.ts";
import { reviewRetakes } from "./retakes.ts";

const span = z
  .object({ start: z.number().nonnegative(), end: z.number().nonnegative() })
  .refine((s) => s.end > s.start);
export const benchmarkReferenceSchema = z.strictObject({
  sampleId: z.string(),
  sourceHash: z.string(),
  confirmedBy: z.string().min(1),
  confirmedAt: z.iso.datetime(),
  text: z.string(),
  words: z
    .array(
      z.object({
        text: z.string(),
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
      }),
    )
    .nullable(),
  expectedDiscarded: z.array(span).nullable(),
});
export type BenchmarkReference = z.infer<typeof benchmarkReferenceSchema>;
/** Edit-distance backtrace gives substitutions/deletions/insertions and matched timing pairs. */
export function wordErrors(reference: string[], hypothesis: string[]) {
  const costs = Array.from(
    { length: reference.length + 1 },
    () => new Uint32Array(hypothesis.length + 1),
  );
  for (let i = 0; i <= reference.length; i++) costs[i][0] = i;
  for (let j = 0; j <= hypothesis.length; j++) costs[0][j] = j;
  for (let i = 1; i <= reference.length; i++)
    for (let j = 1; j <= hypothesis.length; j++)
      costs[i][j] = Math.min(
        costs[i - 1][j] + 1,
        costs[i][j - 1] + 1,
        costs[i - 1][j - 1] + Number(reference[i - 1] !== hypothesis[j - 1]),
      );
  let i = reference.length,
    j = hypothesis.length,
    substitutions = 0,
    deletions = 0,
    insertions = 0;
  const matches: [number, number][] = [];
  while (i || j) {
    if (
      i &&
      j &&
      costs[i][j] ===
        costs[i - 1][j - 1] + Number(reference[i - 1] !== hypothesis[j - 1])
    ) {
      if (reference[i - 1] === hypothesis[j - 1]) matches.push([i - 1, j - 1]);
      else substitutions++;
      i--;
      j--;
    } else if (i && costs[i][j] === costs[i - 1][j] + 1) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }
  return {
    referenceWords: reference.length,
    substitutions,
    deletions,
    insertions,
    matches: matches.reverse(),
    wordErrorRate: reference.length
      ? (substitutions + deletions + insertions) / reference.length
      : hypothesis.length
        ? null
        : 0,
  };
}
const percentile = (values: number[], fraction: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.max(0, Math.ceil(fraction * values.length) - 1)
      ]
    : null;
const intersection = (
  a: { start: number; end: number },
  b: { start: number; end: number },
) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
export function evaluateTranscript(
  reference: BenchmarkReference,
  transcript: Transcript,
  scriptSentences: string[] = [],
) {
  const referenceTokens = speechTokens(reference.text);
  const hypothesis = speechTokens(
    transcript.segments.map((s) => s.text).join(" "),
  );
  const result = wordErrors(referenceTokens, hypothesis);
  const errors = {
    referenceWords: result.referenceWords,
    substitutions: result.substitutions,
    deletions: result.deletions,
    insertions: result.insertions,
    wordErrorRate: result.wordErrorRate,
  };
  const observedWords = transcript.segments
    .flatMap((s) => s.words ?? [])
    .flatMap((w) => speechTokens(w.text).map((text) => ({ ...w, text })));
  const expectedWords =
    reference.words?.flatMap((w) =>
      speechTokens(w.text).map((text) => ({ ...w, text })),
    ) ?? null;
  if (
    expectedWords &&
    expectedWords.map((w) => w.text).join(" ") !== referenceTokens.join(" ")
  )
    throw new Error(
      "Reference words must match the creator-confirmed reference text.",
    );
  const timingMatches = expectedWords
    ? wordErrors(
        expectedWords.map((w) => w.text),
        observedWords.map((w) => w.text),
      ).matches
    : [];
  const boundaryErrors = timingMatches.flatMap(([i, j]) => [
    Math.abs(expectedWords![i].start - observedWords[j].start),
    Math.abs(expectedWords![i].end - observedWords[j].end),
  ]);
  const discarded = reviewRetakes(transcript, scriptSentences).groups.flatMap(
    (g) => g.discarded,
  );
  const expected = reference.expectedDiscarded;
  return {
    ...errors,
    timing: expectedWords
      ? {
          comparedWords: timingMatches.length,
          referenceWords: expectedWords.length,
          medianBoundaryErrorSeconds: percentile(boundaryErrors, 0.5),
          p95BoundaryErrorSeconds: percentile(boundaryErrors, 0.95),
        }
      : null,
    retakes: expected
      ? {
          missed: expected.filter(
            (e) =>
              discarded.reduce((n, s) => n + intersection(e, s), 0) <
              (e.end - e.start) * 0.8,
          ).length,
          incorrectlyDiscarded: discarded.filter(
            (s) =>
              expected.reduce((n, e) => n + intersection(e, s), 0) <
              (s.end - s.start) * 0.8,
          ).length,
          expected: expected.length,
        }
      : null,
  };
}
