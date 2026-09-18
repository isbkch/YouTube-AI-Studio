import { z } from "zod";

export const key = z.string().regex(/^[\w-]{1,120}$/);
export const date = z.iso.date();
const text = z.string().trim().max(2000);
export const metricNames = [
  "views",
  "watchMinutes",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
  "impressions",
  "ctr",
] as const;
export type MetricName = (typeof metricNames)[number];
export const metricSchema = z.object({
  name: z.enum(metricNames),
  value: z.number().finite().nonnegative().nullable(),
  state: z.enum([
    "observed",
    "unavailable",
    "pending",
    "unsupported",
    "omitted",
    "failed",
  ]),
  unit: z.enum(["count", "minutes", "seconds", "percent"]),
});
export type Metric = z.infer<typeof metricSchema>;
export const units: Record<MetricName, Metric["unit"]> = {
  views: "count",
  watchMinutes: "minutes",
  averageViewDuration: "seconds",
  averageViewPercentage: "percent",
  subscribersGained: "count",
  subscribersLost: "count",
  impressions: "count",
  ctr: "percent",
};
export const missingMetrics = (): Metric[] =>
  metricNames.map((name) => ({
    name,
    value: null,
    state: "unavailable",
    unit: units[name],
  }));
export const channelSchema = z.object({
  id: key,
  title: z.string().min(1).max(200),
  mode: z.enum(["youtube", "import", "sample"]),
  connected: z.boolean(),
  verifiedAt: z.string().nullable(),
  lastSync: z.string().nullable(),
  reachJobId: z.string().nullable().default(null),
  catalogComplete: z.boolean().default(false),
  catalogLimit: z.number().int().min(1).max(500).default(50),
  status: z.string().default("Ready"),
});
export type Channel = z.infer<typeof channelSchema>;
export const strategySchema = z.object({
  version: z.number().int().nonnegative().default(0),
  objective: z
    .literal("Business leads and authority")
    .default("Business leads and authority"),
  buyer: text.default(""),
  problem: text.default(""),
  expertise: text.default(""),
  offer: text.default(""),
  cta: text.default(""),
  subjects: z.array(z.string().max(200)).max(20).default([]),
  allowRemoteAnalysis: z.boolean().default(false),
  shareOutcomes: z.boolean().default(false),
  apiApprovalReference: z.string().max(500).default(""),
});
export type Strategy = z.infer<typeof strategySchema>;
export const videoSchema = z.object({
  id: key,
  channelId: key,
  title: z.string().max(300),
  duration: z.number().nonnegative().nullable(),
  publicDate: date.nullable(),
  publicDateSource: z.enum(["youtube", "creator", "unknown"]),
  visibility: z.enum(["public", "private", "unlisted", "unknown"]),
  format: z.enum(["long-form", "short", "live", "unknown"]),
  tags: z.array(z.string().max(100)).max(20).default([]),
  excluded: z.boolean().default(false),
  fetchedAt: z.string(),
  projectId: z.string().nullable().default(null),
});
export type Video = z.infer<typeof videoSchema>;
export const reportSchema = z.object({
  id: key,
  videoId: key,
  channelId: key,
  source: z.enum(["youtube", "studio-csv", "sample"]),
  family: z.enum(["basic", "reach", "traffic", "search", "retention"]),
  start: date,
  end: date,
  through: date.nullable(),
  fetchedAt: z.string(),
  timezone: z.string(),
  filters: z.string().max(2000),
  coverage: z.enum(["complete", "partial", "pending", "failed", "unknown"]),
  metrics: z.array(metricSchema),
  details: z
    .array(z.object({ label: z.string().max(500), value: z.number().finite() }))
    .default([]),
  sourceId: z.string().max(200),
  generatedAt: z.string().nullable().default(null),
});
export type Report = z.infer<typeof reportSchema>;
export const outcomeSchema = z.object({
  id: key,
  channelId: key,
  opportunityId: key,
  videoId: key.nullable(),
  topicId: key.nullable().default(null),
  date,
  kind: z.enum(["conversation", "opportunity", "customer", "authority"]),
  buyerFit: z.enum(["qualified", "uncertain", "not-fit"]),
  attribution: z.enum([
    "prospect-named-video",
    "creator-associated",
    "channel-uncertain",
  ]),
  note: text.default(""),
});
export type Outcome = z.infer<typeof outcomeSchema>;
export const reviewSchema = z.object({
  id: key,
  channelId: key,
  videoId: key,
  days: z.union([z.literal(7), z.literal(28), z.literal(90)]),
  decision: z.enum([
    "follow-up",
    "change-angle",
    "explore-adjacent",
    "inconclusive",
  ]),
  lesson: text,
  outcomesReviewed: z.boolean().default(false),
  noOutcomes: z.boolean().default(false),
  reviewedAt: z.string(),
  snoozedUntil: date.nullable().default(null),
});
export type Review = z.infer<typeof reviewSchema>;
export const briefSchema = z.object({
  title: z.string().trim().min(1).max(200),
  buyer: text.min(1),
  thesis: text.min(1),
  proof: text.min(1),
  cta: text,
  rationale: text.min(1),
  counterEvidence: text.min(1),
  hypothesis: text.min(1),
  kind: z.enum(["follow-up", "buyer-question", "authority"]),
  evidenceLabel: z.enum(["supported", "directional", "explore"]),
  evidenceIds: z.array(key).max(20),
  targetDuration: z.number().int().min(60).max(10800),
});
export type Brief = z.infer<typeof briefSchema>;
export const topicSchema = briefSchema.extend({
  id: key,
  channelId: key,
  batchId: key,
  version: z.number().int().positive(),
  createdAt: z.string(),
  status: z.enum(["proposed", "saved", "dismissed", "in_production"]),
  reason: text,
  projectId: z.string().nullable(),
  strategyVersion: z.number().int(),
  inputHash: z.string(),
  provider: z.string(),
  evidenceUnavailable: z.boolean().default(false),
});
export type Topic = z.infer<typeof topicSchema>;
export type TopicOrigin = {
  channelId: string;
  topicId: string;
  version: number;
  hash: string;
  strategyVersion: number;
  hypothesis: string;
  reviewDays: number[];
};
export const importOptionsSchema = z
  .object({
    channelId: key,
    channelTitle: z.string().min(1).max(200),
    start: date,
    end: date,
    filters: z.string().min(1).max(2000),
    timezone: z.literal("America/Los_Angeles").default("America/Los_Angeles"),
    mapping: z.record(z.string(), z.string()).default({}),
    identityConfirmed: z.boolean().default(false),
  })
  .refine((v) => v.start <= v.end, "Start date must precede end date.");
export type ImportOptions = z.infer<typeof importOptionsSchema>;
export function pacificDate(value: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
export function addDays(value: string, days: number) {
  return new Date(Date.parse(value + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function windowEnd(video: Video, days: number) {
  return video.publicDate ? addDays(video.publicDate, days - 1) : null;
}
