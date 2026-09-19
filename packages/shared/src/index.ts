import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, rename, writeFile, lstat } from "node:fs/promises";
import path from "node:path";

export type ErrorKind =
  | "INVALID_INPUT"
  | "INVALID_PLAN"
  | "CONFLICT"
  | "CONFIGURATION"
  | "MISSING_DEPENDENCY"
  | "EXTERNAL_TOOL"
  | "API"
  | "CANCELLED"
  | "UNSUPPORTED";
export class StudioError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public recovery: string = "Review the input and retry.",
    public retryable = false,
  ) {
    super(message);
    this.name = "StudioError";
  }
}
export function errorInfo(error: unknown) {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    kind: e instanceof StudioError ? e.kind : "EXTERNAL_TOOL",
    message: redact(e.message),
    recovery:
      e instanceof StudioError ? e.recovery : "View the job log and retry.",
    retryable: e instanceof StudioError ? e.retryable : false,
  };
}
export function redact(text: string) {
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export const now = () => new Date().toISOString();

let dotEnvLoaded = false;
/**
 * Load `.env` from a directory once (Node native parser). Variables already
 * set in the real environment always win and are never overwritten.
 */
export function loadDotEnv(directory: string = process.cwd()) {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  try {
    process.loadEnvFile(path.join(directory, ".env"));
  } catch {
    /* No readable .env — environment-only configuration. */
  }
}
/** The OpenAI API key from the environment (incl. `.env`), or null. Never logged. */
export function envCredential(): string | null {
  loadDotEnv();
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? key : null;
}
/** The Gemini API key from the environment (incl. `.env`), or null. Never logged. */
export function geminiEnvCredential(): string | null {
  loadDotEnv();
  const key = (
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  )?.trim();
  return key ? key : null;
}

/**
 * One call against the Gemini Interactions API (image and music generation
 * share it). Returns the model's output content blocks; callers pick the
 * block type they trust (ADR 007: response data, never executable content).
 */
export interface GeminiContentBlock {
  type: string;
  text?: string;
  data?: string;
  mime_type?: string;
}
export async function geminiInteractions(options: {
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  transport?: { fetch?: typeof globalThis.fetch };
}): Promise<{ blocks: GeminiContentBlock[] }> {
  if (!options.apiKey.trim())
    throw new StudioError(
      "CONFIGURATION",
      "Gemini credentials are not configured.",
      "Save a Gemini API key in Settings (macOS Keychain) or set GEMINI_API_KEY in .env.",
    );
  const fetchImpl = options.transport?.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify({ model: options.model, ...options.body }),
        signal: options.signal,
      },
    );
  } catch (e) {
    throw new StudioError(
      "API",
      e instanceof Error ? e.message : "Gemini request failed.",
      "Check network access and credentials, then retry.",
      true,
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string; status?: string };
    steps?: {
      type?: string;
      content?: { type?: string }[];
    }[];
  } | null;
  if (!response.ok) {
    const status = payload?.error?.status ?? String(response.status);
    throw new StudioError(
      "API",
      `Gemini request failed (${status}): ${payload?.error?.message ?? response.statusText}`,
      "Check the model name and credentials, then retry.",
      response.status >= 500 || response.status === 429,
    );
  }
  const blocks: GeminiContentBlock[] = [];
  for (const step of payload?.steps ?? [])
    if (step.type === "model_output" && Array.isArray(step.content))
      blocks.push(...(step.content as GeminiContentBlock[]));
  return { blocks };
}
/** First block of the requested type, or a retryable failure when absent. */
export function geminiBlock(
  blocks: GeminiContentBlock[],
  type: "image" | "audio",
): { data: string; mime: string } {
  const block = blocks.find((b) => b.type === type && b.data);
  if (!block?.data)
    throw new StudioError(
      "API",
      `The Gemini response contained no ${type} data.`,
      "Retry the generation; verified outputs are reused.",
      true,
    );
  return { data: block.data, mime: block.mime_type ?? defaultGeminiMime(type) };
}
function defaultGeminiMime(type: "image" | "audio") {
  return type === "image" ? "image/png" : "audio/mpeg";
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export async function fileHash(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
export function slugify(title: string) {
  return (
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 72) || "untitled"
  );
}
export function inside(root: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0"))
    throw new StudioError("INVALID_INPUT", "Expected a project-relative path.");
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw new StudioError("INVALID_INPUT", "Path escapes project directory.");
  return target;
}
/** Reject symlink components as well as lexical traversal. Used for all managed files. */
export async function safePath(root: string, relative: string) {
  const target = inside(root, relative);
  const base = await realpath(root);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new StudioError(
          "INVALID_INPUT",
          "Symlinks are not allowed inside managed project paths.",
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (base !== (await realpath(root)))
    throw new StudioError("CONFLICT", "Project path changed.");
  return target;
}
export async function atomicJSON(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export interface Usage {
  agent: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
  imageCount: number;
  costUSD: number | null;
  elapsedMs: number;
  createdAt: string;
}
/** Steering level for how many animations/effects the Director plans. */
export type VisualDensity = "minimal" | "balanced" | "rich";
/**
 * Tolerant read for values persisted before the field existed (project
 * snapshots, stored plans): anything unrecognized reads as the default.
 */
export function asVisualDensity(value: unknown): VisualDensity {
  return value === "minimal" || value === "rich" ? value : "balanced";
}
/**
 * How aggressively the deterministic A-roll cut removes silence: "natural"
 * keeps today's pacing, "tight" and "punchy" cut interior word gaps and trim
 * scene edges closer to the spoken words.
 */
export type SilenceTightening = "natural" | "tight" | "punchy";
/** Tolerant read in the same shape as `asVisualDensity`. */
export function asSilenceTightening(value: unknown): SilenceTightening {
  return value === "tight" || value === "punchy" ? value : "natural";
}
/** How punch-line subtitles animate over the assembled cut. */
export type CaptionStyle = "none" | "pop" | "karaoke";
/** Tolerant read in the same shape as `asVisualDensity`. */
export function asCaptionStyle(value: unknown): CaptionStyle {
  return value === "pop" || value === "karaoke" ? value : "none";
}
/** Narration audio engineering the deterministic mix applies. */
export type AudioPolish = "natural" | "polished" | "loud";
/** Tolerant read in the same shape as `asVisualDensity`. */
export function asAudioPolish(value: unknown): AudioPolish {
  return value === "polished" || value === "loud" ? value : "natural";
}
/**
 * How far narration audio may lead its video at scene boundaries: "none"
 * keeps the hard A/V cut, "subtle" lets room tone and first words breathe
 * across the cut by a fraction of the available word gap, "flowing" uses the
 * whole available gap. Computed deterministically from word timings by the
 * assembly, never the model.
 */
export type NarrationLead = "none" | "subtle" | "flowing";
/** Tolerant read in the same shape as `asVisualDensity`. */
export function asNarrationLead(value: unknown): NarrationLead {
  return value === "subtle" || value === "flowing" ? value : "none";
}
/** How liberally the visual pass proposes SFX events. */
export type SfxDensity = "sparse" | "punctuated" | "playful";
/**
 * The director the creator hires for a production. The persona resolves to
 * the derived style bundle below; the individual knobs it drives stay
 * recorded on each plan, and explicit per-generation overrides still win.
 */
export type DirectorId = "purist" | "craftsman" | "showman";
/**
 * Tolerant read for creator profiles persisted before the director existed:
 * anything unrecognized reads as the default director for creators. Plans use
 * their own schema default ("purist") so legacy plans keep their behavior.
 */
export function asDirectorPersona(value: unknown): DirectorId {
  return value === "purist" || value === "showman" ? value : "craftsman";
}
/** The derived style each director brings to a production. */
export interface DirectorStyle {
  name: string;
  tagline: string;
  visualDensity: VisualDensity;
  silenceTightening: SilenceTightening;
  captionStyle: CaptionStyle;
  sfxDensity: SfxDensity;
  audioPolish: AudioPolish;
  narrationLead: NarrationLead;
}
/**
 * The resolved direction a plan is generated under: the persona plus the
 * knob values it drove (explicit per-generation overrides included). Studio
 * computes it once and hands it to the Director agent, which records it on
 * the plan and threads it into prompts.
 */
export interface DirectedStyle {
  director: DirectorId;
  visualDensity: VisualDensity;
  silenceTightening: SilenceTightening;
  captionStyle: CaptionStyle;
  audioPolish: AudioPolish;
  narrationLead: NarrationLead;
}
/**
 * Single source of truth for what each director means. The plan records the
 * resolved captionStyle/audioPolish (and the density/tightening knobs); the
 * visual pass and build read the persona for everything else.
 */
export const DIRECTOR_PROFILES: Record<DirectorId, DirectorStyle> = {
  purist: {
    name: "The Purist",
    tagline: "Let the content speak.",
    visualDensity: "minimal",
    silenceTightening: "natural",
    captionStyle: "none",
    sfxDensity: "sparse",
    audioPolish: "natural",
    narrationLead: "none",
  },
  craftsman: {
    name: "The Craftsman",
    tagline: "Polish it until it shines.",
    visualDensity: "rich",
    silenceTightening: "tight",
    captionStyle: "pop",
    sfxDensity: "punctuated",
    audioPolish: "polished",
    narrationLead: "subtle",
  },
  showman: {
    name: "The Showman",
    tagline: "Keep them watching, by all means.",
    visualDensity: "rich",
    silenceTightening: "punchy",
    captionStyle: "karaoke",
    sfxDensity: "playful",
    audioPolish: "loud",
    narrationLead: "flowing",
  },
};
export interface CreatorProfile {
  name: string;
  channel: string;
  format: string;
  targetMinutes: [number, number];
  subjects: string[];
  /**
   * The hired director. Owns the derived knobs below: the profile stores the
   * persona's resolved visualDensity/silenceTightening so snapshots stay
   * self-describing, but regeneration derives them from the director.
   */
  director: DirectorId;
  /** Advises the Director: fewer visuals (minimal) vs graphics-first (rich). */
  visualDensity: VisualDensity;
  /** Advises the deterministic A-roll editor, never the model. */
  silenceTightening: SilenceTightening;
  brand: {
    background: string;
    foreground: string;
    accent: string;
    fontFamily: string;
  };
  preferences: {
    id: string;
    text: string;
    source: "explicit";
    createdAt: string;
  }[];
}
export const defaultCreator: CreatorProfile = {
  name: "iLyas",
  channel: "YouTube-AI-Studio",
  format: "Long-form technical YouTube essay",
  targetMinutes: [12, 18],
  director: "craftsman",
  visualDensity: DIRECTOR_PROFILES.craftsman.visualDensity,
  silenceTightening: DIRECTOR_PROFILES.craftsman.silenceTightening,
  subjects: [
    "cloud architecture",
    "reliability",
    "distributed systems",
    "AI-assisted software development",
    "engineering leadership",
  ],
  brand: {
    background: "#101b29",
    foreground: "#f2f4ed",
    accent: "#c8ef80",
    fontFamily: "Helvetica Neue",
  },
  preferences: [
    "Prefer diagrams over generic imagery.",
    "Use punch-ins sparingly.",
    "Keep visuals simple when the explanation needs room.",
    "Use 3D intentionally, not decoratively.",
  ].map((text, i) => ({
    id: `pref-${i}`,
    text,
    source: "explicit",
    createdAt: "2026-09-16T00:00:00.000Z",
  })),
};
