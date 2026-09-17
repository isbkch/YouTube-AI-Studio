import { StudioError } from "../../shared/src/index.ts";
import type { BlenderProvider } from "../../blender-engine/src/index.ts";
import type { ImageProvider } from "../../image-engine/src/index.ts";
import type { MusicProvider } from "../../music-engine/src/index.ts";
import type { ProductionPlan } from "../../production-plan/src/index.ts";
import type { LibraryManifest } from "./library.ts";

/**
 * Runtime capability advertisement (ADR 007): what the visual-direction pass
 * may plan with, and what execution will accept. A model may recommend an
 * unavailable engine, but the build rejects it here.
 */
export interface EngineCapabilities {
  remotion: { templates: number; engine: "remotion" };
  "gpt-image": { engine: "gpt-image"; model: string } | null;
  blender: { engine: "blender"; version: string } | null;
  /** Music-bed generation engine; null restricts beds to library tracks. */
  musicGeneration: { model: string; clipSeconds: number } | null;
  musicLibrary: { music: number; sfx: number };
}
export function engineCapabilities(
  images: ImageProvider | null,
  library: LibraryManifest,
  blender: BlenderProvider | null,
  music: MusicProvider | null = null,
): EngineCapabilities {
  return {
    remotion: { engine: "remotion", templates: 11 },
    "gpt-image": images ? { engine: "gpt-image", model: images.model } : null,
    blender: blender ? { engine: "blender", version: blender.version } : null,
    musicGeneration: music
      ? { model: music.model, clipSeconds: music.clipSeconds }
      : null,
    musicLibrary: {
      music: library.tracks.filter((t) => t.kind === "music").length,
      sfx: library.tracks.filter((t) => t.kind === "sfx").length,
    },
  };
}

/** Execution-time gate: every engine a plan references must be configured. */
export function validateEngines(
  plan: ProductionPlan,
  images: ImageProvider | null,
  blender: BlenderProvider | null = null,
  music: MusicProvider | null = null,
) {
  for (const scene of plan.scenes)
    for (const b of scene.broll) {
      const engine = b.asset.engine;
      if (engine === "gpt-image") {
        if (!images)
          throw new StudioError(
            "UNSUPPORTED",
            `${scene.id}/${b.id}: B-roll engine "gpt-image" is not configured.`,
            "Connect an image provider in Settings or remove the B-roll entry.",
          );
      } else if (engine === "blender") {
        if (!blender)
          throw new StudioError(
            "UNSUPPORTED",
            `${scene.id}/${b.id}: B-roll engine "blender" is not configured.`,
            "Install Blender (or set WTS_BLENDER_PATH) or remove the B-roll entry.",
          );
      } else
        throw new StudioError(
          "UNSUPPORTED",
          `${scene.id}/${b.id}: unknown B-roll engine "${engine}".`,
          "Re-plan with an engine the runtime advertises.",
        );
    }
  if (plan.audioDesign.music?.source === "generated" && !music)
    throw new StudioError(
      "UNSUPPORTED",
      "The plan's music bed is generated, but no music generation engine is configured.",
      "Choose a Music provider in Settings (or --music mock|gemini), or re-run the visual pass against the library.",
    );
}
