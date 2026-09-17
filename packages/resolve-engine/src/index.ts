import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBinary } from "../../media/src/index.ts";
import { StudioError } from "../../shared/src/index.ts";
export const resolveApp = () =>
  process.env.WTS_RESOLVE_APP ||
  "/Applications/DaVinci Resolve/DaVinci Resolve.app";
/** Headless final-render presets Resolve must have installed. */
export const FINAL_RENDER_PRESETS = [
  "H.264 Master",
  "H.264 Narrative",
  "ProRes 422 HQ",
  "ProRes 422",
] as const;
export type FinalRenderPreset = (typeof FINAL_RENDER_PRESETS)[number];
const fusionDir = fileURLToPath(
  new URL("../../../assets/fusion", import.meta.url),
);
/** Checked-in Fusion finishing macros; never model-generated content. */
export async function fusionMacros() {
  try {
    return (await readdir(fusionDir))
      .filter((f) => f.endsWith(".setting"))
      .map((f) => path.basename(f, ".setting"))
      .sort();
  } catch {
    return [];
  }
}
export async function fusionMacroPath(macroId: string) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(macroId))
    throw new StudioError(
      "INVALID_INPUT",
      "Fusion macro ID must be a simple slug.",
    );
  const file = path.join(fusionDir, `${macroId}.setting`);
  try {
    await access(file, constants.R_OK);
  } catch {
    throw new StudioError(
      "INVALID_INPUT",
      `Unknown Fusion macro ${macroId}.`,
      `Choose one of: ${(await fusionMacros()).join(", ") || "(none checked in)"}.`,
    );
  }
  return file;
}
export interface ResolveProbe {
  available: boolean;
  version?: string;
  product?: string;
  reason?: string;
}
export async function resolveCommand(
  command: "probe" | "import" | "render",
  file?: string,
  name?: string,
  output?: string,
  preset?: FinalRenderPreset,
  macro?: string,
  signal?: AbortSignal,
): Promise<
  ResolveProbe & {
    project?: string;
    timeline?: string;
    videoTracks?: number;
    audioTracks?: number;
    startFrame?: number;
    endFrame?: number;
    fusionMacro?: string;
    fusionApplied?: number;
    renderJob?: string;
    renderStatus?: string;
    output?: string | null;
  }
> {
  const interpreter = path.join(
    resolveApp(),
    "Contents/Applications/ResolvePython",
  );
  try {
    await access(interpreter, constants.X_OK);
  } catch {
    throw new StudioError(
      "UNSUPPORTED",
      "Resolve 21.1 bundled Python was not found.",
      "Use the exported FCPXML or OTIO from Resolve’s Import Timeline command. Earlier versions need a configured external Python interpreter.",
    );
  }
  const script = fileURLToPath(new URL("./bridge.py", import.meta.url));
  const args = [script, command];
  if (command === "import") {
    if (
      !file ||
      !path.isAbsolute(file) ||
      ![".fcpxml", ".otio"].includes(path.extname(file))
    )
      throw new StudioError(
        "INVALID_INPUT",
        "Resolve import requires an exported timeline file.",
      );
    args.push(file, name || "YouTube-AI-Studio");
  }
  if (command === "render") {
    if (
      !file ||
      !path.isAbsolute(file) ||
      path.extname(file) !== ".fcpxml" ||
      !output ||
      !path.isAbsolute(output) ||
      !preset ||
      (FINAL_RENDER_PRESETS as readonly string[]).includes(preset) === false
    )
      throw new StudioError(
        "INVALID_INPUT",
        "Final render requires the exported FCPXML, an absolute output path and a known preset.",
      );
    args.push(file, name || "YouTube-AI-Studio Final", output, preset);
    if (macro) args.push(await fusionMacroPath(macro));
  }
  const { stdout } = await runBinary(interpreter, args, {
    signal,
    // A final render legitimately takes hours; every other action is quick.
    timeoutMs: command === "render" ? 4 * 60 * 60 * 1000 : 30000,
  });
  const line = stdout.split("\n").find((l) => l.startsWith("WTS_RESULT:"));
  if (!line)
    throw new StudioError(
      "EXTERNAL_TOOL",
      "Resolve returned no structured result.",
      "Open Resolve and enable local external scripting if available. Use FCPXML import as a fallback.",
    );
  return JSON.parse(line.slice("WTS_RESULT:".length));
}
