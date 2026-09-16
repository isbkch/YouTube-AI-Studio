import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBinary } from "../../media/src/index.ts";
import { StudioError } from "../../shared/src/index.ts";
export const resolveApp = () =>
  process.env.WTS_RESOLVE_APP ||
  "/Applications/DaVinci Resolve/DaVinci Resolve.app";
export interface ResolveProbe {
  available: boolean;
  version?: string;
  product?: string;
  reason?: string;
}
export async function resolveCommand(
  command: "probe" | "import",
  file?: string,
  name?: string,
): Promise<
  ResolveProbe & {
    project?: string;
    timeline?: string;
    videoTracks?: number;
    audioTracks?: number;
    startFrame?: number;
    endFrame?: number;
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
    args.push(file, name || "WinTheCloud Studio");
  }
  const { stdout } = await runBinary(interpreter, args, { timeoutMs: 30000 });
  const line = stdout.split("\n").find((l) => l.startsWith("WTS_RESULT:"));
  if (!line)
    throw new StudioError(
      "EXTERNAL_TOOL",
      "Resolve returned no structured result.",
      "Open Resolve and enable local external scripting if available. Use FCPXML import as a fallback.",
    );
  return JSON.parse(line.slice("WTS_RESULT:".length));
}
