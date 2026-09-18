import type { Transcript } from "./model.ts";

type Segment = Transcript["segments"][number];
type Phrase = Segment & { complete: boolean };
export interface RetakeGroup {
  kept: Segment;
  discarded: Segment[];
}
export interface RetakeReview {
  segments: Segment[];
  groups: RetakeGroup[];
}

const terminal = /[.!?]["'”’)]*$/;
const multipleSentences = /[.!?]["'”’)]*\s+\S/;
const words = (text: string) =>
  text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? [];
// Ignore only small delivery differences. Negation, numbers and content words
// remain significant: "is safe" and "is not safe" are different statements.
const signature = (text: string) =>
  words(text)
    .filter((word) => !/^(a|an|the|uh|um|erm|er)$/.test(word))
    .join(" ");
const MAX_RETAKE_GAP = 10;

/** Sentence boundaries use real word times; never invent sub-segment timing. */
function phrases(transcript: Pick<Transcript, "segments">): Phrase[] {
  const chunks: Phrase[] = [];
  for (const segment of transcript.segments) {
    if (
      segment.words?.length &&
      words(segment.words.map((w) => w.text).join(" ")).join(" ") ===
        words(segment.text).join(" ")
    ) {
      let pending: NonNullable<Segment["words"]> = [];
      let part = 0;
      const flush = () => {
        if (!pending.length) return;
        const text = pending.map((w) => w.text).join(" ");
        chunks.push({
          id: `${segment.id}-phrase-${++part}`,
          start: pending[0].start,
          end: pending.at(-1)!.end,
          text,
          words: pending,
          complete: terminal.test(text),
        });
        pending = [];
      };
      for (const word of segment.words) {
        pending.push(word);
        if (terminal.test(word.text)) flush();
      }
      flush();
    } else chunks.push({ ...segment, complete: terminal.test(segment.text) });
  }
  const result: Phrase[] = [];
  for (const chunk of chunks) {
    const previous = result.at(-1);
    if (
      previous &&
      !previous.complete &&
      chunk.start - previous.end <= 2 &&
      words(previous.text).length + words(chunk.text).length <= 80
    ) {
      previous.text += ` ${chunk.text}`;
      previous.end = chunk.end;
      previous.complete = chunk.complete;
      previous.words =
        previous.words && chunk.words
          ? [...previous.words, ...chunk.words]
          : undefined;
    } else result.push({ ...chunk });
  }
  return result;
}

/** Non-destructive review shared by the transcript UI and the A-roll editor. */
export function reviewRetakes(
  transcript: Pick<Transcript, "segments">,
  scriptSentences: string[] = [],
): RetakeReview {
  const scripted = new Map<string, number>();
  for (const text of scriptSentences) {
    const key = signature(text);
    scripted.set(key, (scripted.get(key) ?? 0) + 1);
  }
  const utterances = phrases(transcript);
  const groups: RetakeGroup[] = [];
  for (let i = 0; i < utterances.length; i++) {
    const first = utterances[i];
    const key = signature(first.text);
    // Short rhetorical beats and intentional script repetition stay intact.
    if (
      words(first.text).length < 3 ||
      words(key).length < 2 ||
      multipleSentences.test(first.text) ||
      (scripted.get(key) ?? 0) > 1
    )
      continue;
    const attempts = [first];
    while (i + 1 < utterances.length) {
      const next = utterances[i + 1];
      if (
        !next.complete ||
        next.start - attempts.at(-1)!.end > MAX_RETAKE_GAP ||
        signature(next.text) !== key
      )
        break;
      attempts.push(next);
      i++;
    }
    if (attempts.length > 1)
      groups.push({ kept: attempts.at(-1)!, discarded: attempts.slice(0, -1) });
  }
  const discarded = new Set(
    groups.flatMap((g) => g.discarded.map((s) => s.id)),
  );
  return {
    // Preserve the original segmentation when there is nothing to collapse.
    segments: groups.length
      ? utterances.filter((s) => !discarded.has(s.id))
      : transcript.segments,
    groups,
  };
}

export const discardedRetakes = (review: RetakeReview) =>
  review.groups.flatMap((g) => g.discarded);

export function crossesRetake(
  start: number,
  end: number,
  discarded: Pick<Segment, "start" | "end">[],
): boolean {
  return discarded.some((s) => start < s.end && end > s.start);
}
