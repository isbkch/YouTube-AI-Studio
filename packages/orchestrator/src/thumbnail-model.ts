import { z } from "zod";

export const thumbnailSlotSchema = z.enum(["A", "B"]);
export type ThumbnailSlotId = z.infer<typeof thumbnailSlotSchema>;
export const thumbnailContextSchema = z.object({
  packagingVersion: z.number().int().positive(),
});
export const thumbnailEditSchema = thumbnailContextSchema.extend({
  slot: thumbnailSlotSchema,
  expectedRevision: z.number().int().nonnegative(),
  conceptId: z.string().min(1).max(101),
  headline: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .refine(
      (s) => !/[\x00-\x09\x0b-\x1f]/.test(s),
      "Headline contains control characters.",
    ),
  direction: z.string().trim().min(1).max(600),
});
export const thumbnailRenderSchema = thumbnailContextSchema.extend({
  slots: z
    .array(
      z.object({
        slot: thumbnailSlotSchema,
        expectedRevision: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(2)
    .refine(
      (s) => new Set(s.map((v) => v.slot)).size === s.length,
      "Select each slot once.",
    ),
});
export const thumbnailRegenerateSchema = thumbnailContextSchema.extend({
  slot: thumbnailSlotSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export const thumbnailSelectSchema = thumbnailContextSchema
  .extend({
    slot: thumbnailSlotSchema.nullable(),
    revision: z.number().int().positive().nullable(),
    expectedRevision: z.number().int().nonnegative().nullable(),
  })
  .refine(
    (v) =>
      v.slot === null
        ? v.revision === null && v.expectedRevision === null
        : v.revision !== null && v.expectedRevision !== null,
    "Select an exact revision, or clear all selection fields.",
  );
export type ThumbnailEdit = z.infer<typeof thumbnailEditSchema>;
export type ThumbnailRender = z.infer<typeof thumbnailRenderSchema>;
export type ThumbnailSelection = {
  packagingVersion: number;
  packagingHash: string;
  slot: ThumbnailSlotId;
  revision: number;
  path: string;
  outputHash: string;
};
export interface ThumbnailBackground {
  path: string;
  hash: string;
  inputHash: string;
  provider: string;
  model: string;
}
export interface ThumbnailRevision {
  revision: number;
  conceptId: string;
  headline: string;
  direction: string;
  background: ThumbnailBackground;
  path: string;
  outputHash: string;
  inputHash: string;
  createdAt: string;
  jobId: string;
}
export interface ThumbnailSlot {
  id: ThumbnailSlotId;
  /** Optimistic editor token, independent of successful image revision numbers. */
  version: number;
  conceptId: string;
  headline: string;
  direction: string;
  emotionalHook: string;
  generation: number;
  status: "CONCEPT" | "RUNNING" | "READY" | "FAILED" | "CANCELLED";
  stage: string | null;
  error: string | null;
  background: ThumbnailBackground | null;
  currentRevision: number | null;
  revisions: ThumbnailRevision[];
}
export interface ThumbnailPackage {
  packagingVersion: number;
  packagingHash: string;
  slots: ThumbnailSlot[];
}
export interface ThumbnailState {
  current: ThumbnailPackage;
  history: ThumbnailPackage[];
  selected: ThumbnailSelection | null;
}
