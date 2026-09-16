import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { executable, runBinary } from "../../media/src/index.ts";
import { defaultRoot } from "./store.ts";
import { resolveApp } from "../../resolve-engine/src/index.ts";
import { defaultWhisperModel } from "../../agents/src/whisper.ts";
import { envCredential, loadDotEnv } from "../../shared/src/index.ts";
import { readLibrary } from "./library.ts";
import { youTubeCLI } from "./youtube.ts";
export interface Check {
  name: string;
  status: "AVAILABLE" | "NOT FOUND" | "UNSUPPORTED VERSION";
  version: string;
  required: boolean;
  guidance: string;
}
export async function hasCredential() {
  loadDotEnv();
  if (envCredential()) return true;
  try {
    await runBinary(
      "/usr/bin/security",
      ["find-generic-password", "-s", "com.winthecloud.studio", "-a", "openai"],
      { timeoutMs: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}
/**
 * OpenAI key resolution: environment/.env first, macOS Keychain second.
 * The value never appears in logs, events or project files.
 */
export async function openAICredential(): Promise<string> {
  loadDotEnv();
  const fromEnv = envCredential();
  if (fromEnv) return fromEnv;
  return keychainCredential();
}
export async function keychainCredential() {
  const result = await runBinary(
    "/usr/bin/security",
    [
      "find-generic-password",
      "-s",
      "com.winthecloud.studio",
      "-a",
      "openai",
      "-w",
    ],
    { timeoutMs: 10000 },
  );
  return result.stdout.trim();
}
export async function doctor(root = defaultRoot()) {
  const checks: Check[] = [
    {
      name: "macOS",
      status:
        process.platform === "darwin" ? "AVAILABLE" : "UNSUPPORTED VERSION",
      version: os.release(),
      required: true,
      guidance: "The desktop app requires macOS 14 or newer.",
    },
    {
      name: "Architecture",
      status: ["arm64", "x64"].includes(process.arch)
        ? "AVAILABLE"
        : "UNSUPPORTED VERSION",
      version: process.arch,
      required: true,
      guidance: "Apple Silicon and Intel Macs are supported.",
    },
    {
      name: "Node.js",
      status:
        Number(process.versions.node.split(".")[0]) >= 24
          ? "AVAILABLE"
          : "UNSUPPORTED VERSION",
      version: process.versions.node,
      required: true,
      guidance: "Install Node.js 24 or newer (nodejs.org).",
    },
  ];
  if (process.platform === "darwin") {
    try {
      checks[0].version = (
        await runBinary("/usr/bin/sw_vers", ["-productVersion"], {
          timeoutMs: 5000,
        })
      ).stdout.trim();
    } catch {
      /* Kernel version is still available. */
    }
  }
  const tools = await Promise.all(
    (["bun", "ffmpeg", "ffprobe", "whisper-cli", "blender"] as const).map(
      async (tool) => {
        try {
          const binary = await executable(tool);
          const { stdout, stderr } = await runBinary(
            binary,
            [
              tool === "ffmpeg" || tool === "ffprobe"
                ? "-version"
                : "--version",
            ],
            { timeoutMs: 15000 },
          );
          return {
            name: tool,
            status: "AVAILABLE" as const,
            version: (stdout || stderr).split("\n")[0],
            required: tool === "ffmpeg" || tool === "ffprobe",
            guidance: binary,
          };
        } catch {
          return {
            name: tool,
            status: "NOT FOUND" as const,
            version: "",
            required: tool === "ffmpeg" || tool === "ffprobe",
            guidance: `Install ${tool} or set WTS_${tool.toUpperCase().replace(/-/g, "_")}_PATH. ${tool === "blender" ? "Optional; 3D is not required." : tool === "whisper-cli" ? "Optional; enables free local transcription." : ""}`,
          };
        }
      },
    ),
  );
  checks.push(...tools);
  try {
    const model = defaultWhisperModel();
    if ((await stat(model)).isFile()) {
      checks.push({
        name: "Whisper model",
        status: "AVAILABLE",
        version: path.basename(model),
        required: false,
        guidance: model,
      });
    } else {
      checks.push({
        name: "Whisper model",
        status: "NOT FOUND",
        version: "",
        required: false,
        guidance: `Set WTS_WHISPER_MODEL to a ggml model (expected ${model}).`,
      });
    }
  } catch {
    checks.push({
      name: "Whisper model",
      status: "NOT FOUND",
      version: "",
      required: false,
      guidance:
        "Set WTS_WHISPER_MODEL to a ggml model for local transcription.",
    });
  }
  checks.push({
    name: "Remotion",
    status: "AVAILABLE",
    version: "4.0.525",
    required: true,
    guidance: "First render downloads Chrome Headless Shell if absent.",
  });
  try {
    await access(resolveApp());
    const plist = path.join(resolveApp(), "Contents/Info.plist");
    const version = (
      await runBinary(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print CFBundleShortVersionString", plist],
        { timeoutMs: 5000 },
      )
    ).stdout.trim();
    checks.push({
      name: "DaVinci Resolve",
      status: "AVAILABLE",
      version,
      required: false,
      guidance:
        "Detection does not prove scripting access. Use FCPXML import or test the Resolve connection.",
    });
  } catch {
    checks.push({
      name: "DaVinci Resolve",
      status: "NOT FOUND",
      version: "",
      required: false,
      guidance:
        "Optional: preview and timeline exports work without Resolve. Set WTS_RESOLVE_APP for a custom installation.",
    });
  }
  checks.push({
    name: "OpenAI credentials",
    status: (await hasCredential()) ? "AVAILABLE" : "NOT FOUND",
    version: envCredential()
      ? "OPENAI_API_KEY (.env/environment)"
      : "macOS Keychain",
    required: false,
    guidance:
      "Set OPENAI_API_KEY in .env or save a key in the app’s Settings. Mock and local whisper need no key.",
  });
  checks.push({
    name: "Image generation",
    status: (await hasCredential()) ? "AVAILABLE" : "NOT FOUND",
    version: process.env.WTS_IMAGE_MODEL || "gpt-image-1",
    required: false,
    guidance:
      "Shares the OpenAI credential: enables GPT-image B-roll. The mock provider renders deterministic gradient stills without credits.",
  });
  try {
    const cli = await youTubeCLI();
    checks.push({
      name: "YouTube CLI",
      status: "AVAILABLE",
      version: path.basename(cli),
      required: false,
      guidance: `${cli} — publishing runs through it after packaging approval; WTS_YOUTUBE_ARGS appends OAuth flags.`,
    });
  } catch {
    checks.push({
      name: "YouTube CLI",
      status: "NOT FOUND",
      version: "",
      required: false,
      guidance:
        "Optional: install youtubeuploader or set WTS_YOUTUBEUPLOADER_PATH to enable direct publishing. Without it, packaging still works and the upload is manual.",
    });
  }
  try {
    const library = await readLibrary(root);
    const music = library.tracks.filter((t) => t.kind === "music").length;
    const sfx = library.tracks.filter((t) => t.kind === "sfx").length;
    checks.push({
      name: "Music/SFX library",
      status: "AVAILABLE",
      version: `${music} music, ${sfx} SFX`,
      required: false,
      guidance: path.join(root, "library"),
    });
  } catch (e) {
    checks.push({
      name: "Music/SFX library",
      status: "NOT FOUND",
      version: "",
      required: false,
      guidance: e instanceof Error ? e.message : "Fix library/library.json.",
    });
  }
  try {
    await mkdir(root, { recursive: true });
    await access(root, constants.W_OK);
    checks.push({
      name: "Project directory",
      status: "AVAILABLE",
      version: root,
      required: true,
      guidance: "Local files; metadata in studio.sqlite.",
    });
  } catch {
    checks.push({
      name: "Project directory",
      status: "NOT FOUND",
      version: root,
      required: true,
      guidance: "Choose a writable WTS_HOME directory.",
    });
  }
  return {
    checks,
    overall: checks.some((c) => c.required && c.status !== "AVAILABLE")
      ? "ACTION REQUIRED"
      : "READY",
    providerDefault: "mock",
  };
}
