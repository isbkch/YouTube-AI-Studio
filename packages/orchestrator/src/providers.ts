import {
  MockAIProvider,
  OpenAIProvider,
  type AIProvider,
  type Transcriber,
} from "../../agents/src/index.ts";
import { GPTTranscriber } from "../../agents/src/gpt-transcription.ts";
import { WhisperCLIProvider } from "../../agents/src/whisper.ts";
import {
  GeminiImageProvider,
  MockImageProvider,
  OpenAIImageProvider,
} from "../../image-engine/src/index.ts";
import {
  GeminiMusicProvider,
  MockMusicProvider,
} from "../../music-engine/src/index.ts";
import { geminiEnvCredential, envCredential } from "../../shared/src/index.ts";
import { keychainCredential } from "./doctor.ts";
import type { Studio } from "./studio.ts";
import type { ProviderSelection } from "./store.ts";

export type CredentialSource = "env" | "keychain" | "session" | "none";
export interface ProviderCredentials {
  openAI: string;
  gemini: string;
  openAISource: CredentialSource;
  geminiSource: CredentialSource;
}
/**
 * Credential resolution: session key (Settings "Apply") → environment/.env →
 * macOS Keychain. Values never appear in logs, events or project files.
 */
export async function resolveCredentials(
  session: { openAI?: string; gemini?: string } = {},
): Promise<ProviderCredentials> {
  const resolve = async (
    sessionKey: string | undefined,
    envKey: string | null,
    account: "openai" | "gemini",
  ) => {
    if (sessionKey)
      return { key: sessionKey, source: "session" as CredentialSource };
    if (envKey) return { key: envKey, source: "env" as CredentialSource };
    try {
      const key = await keychainCredential(account);
      if (key) return { key, source: "keychain" as CredentialSource };
    } catch {
      /* No Keychain item — free engines still work. */
    }
    return { key: "", source: "none" as CredentialSource };
  };
  const [openAI, gemini] = await Promise.all([
    resolve(session.openAI, envCredential(), "openai"),
    resolve(session.gemini, geminiEnvCredential(), "gemini"),
  ]);
  return {
    openAI: openAI.key,
    gemini: gemini.key,
    openAISource: openAI.source,
    geminiSource: gemini.source,
  };
}

export interface AppliedProviders {
  director: string;
  transcription: string;
  images: ProviderSelection["images"] | null;
  music: ProviderSelection["music"];
  imageModel: string;
  musicModel: string;
  openAICredentialSource: CredentialSource;
  geminiCredentialSource: CredentialSource;
}

/** Strict image-only setup; offline thumbnail edits need no other engine credentials. */
export function configuredImageProvider(
  selection: Pick<ProviderSelection, "images" | "imageModel">,
  credentials: ProviderCredentials,
) {
  const options = { model: selection.imageModel || undefined };
  if (selection.images === "openai")
    return new OpenAIImageProvider(credentials.openAI, options);
  if (selection.images === "gemini")
    return new GeminiImageProvider(credentials.gemini, options);
  return new MockImageProvider();
}

/**
 * Turn a provider selection into live engines on a Studio. Strict mode (the
 * Settings "Apply") fails loudly when a billed provider lacks its credential;
 * lenient mode (runtime startup, CLI defaults) falls back to free engines so
 * a vanished key never keeps the library from opening.
 */
export function applyProviderSelection(
  studio: Studio,
  selection: ProviderSelection,
  credentials: ProviderCredentials,
  options: { lenient?: boolean; whisperModel?: string } = {},
): AppliedProviders {
  const attempt = <T>(build: () => T, fallback: T): T => {
    try {
      return build();
    } catch (e) {
      if (options.lenient) return fallback;
      throw e;
    }
  };
  const directorModel = selection.directorModel || undefined;
  studio.provider =
    selection.director === "openai"
      ? attempt<AIProvider>(
          () => new OpenAIProvider(credentials.openAI, directorModel),
          new MockAIProvider(),
        )
      : new MockAIProvider();
  studio.transcription =
    selection.transcription === "whisper"
      ? new WhisperCLIProvider(options.whisperModel)
      : selection.transcription === "openai"
        ? attempt<Transcriber>(
            () => new GPTTranscriber(credentials.openAI),
            new MockAIProvider(),
          )
        : new MockAIProvider();
  studio.images = attempt(
    () => configuredImageProvider(selection, credentials),
    null,
  );
  studio.music =
    selection.music === "gemini"
      ? attempt(
          () =>
            new GeminiMusicProvider(credentials.gemini, {
              model: selection.musicModel || undefined,
            }),
          null,
        )
      : selection.music === "mock"
        ? new MockMusicProvider()
        : null; // "library": beds come from the creator's library only.
  return {
    director: studio.provider.name,
    transcription: studio.transcription.name,
    images: studio.images
      ? ((studio.images instanceof MockImageProvider
          ? "mock"
          : studio.images instanceof GeminiImageProvider
            ? "gemini"
            : "openai") satisfies ProviderSelection["images"])
      : null,
    music: studio.music
      ? studio.music instanceof GeminiMusicProvider
        ? "gemini"
        : "mock"
      : "library",
    imageModel: studio.images?.model ?? "",
    musicModel: studio.music?.model ?? "",
    openAICredentialSource: credentials.openAISource,
    geminiCredentialSource: credentials.geminiSource,
  };
}
