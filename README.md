# WinTheCloud Studio

A native macOS production dashboard for technical YouTube videos. The creator approves the script, reviews the storyboard, and directs the rough cut. A local TypeScript runtime validates the production plan and executes trusted media workers.

**This repository produces actual media.** The credit-free demo creates 72 seconds of synthetic A-roll with system-voice narration, renders four Remotion graphics, assembles a local rough cut, exports editable Resolve timelines, then changes one callout and proves that only one graphic and one preview segment regenerate.

## Start here

Prerequisites: macOS 14+, Xcode command-line tools with Swift 6+, Node.js 24+, pnpm 10+, and FFmpeg/ffprobe with libx264 and libmp3lame. Paths are detected; Homebrew is not required. Resolve and Blender are optional.

```sh
pnpm install
pnpm check
pnpm demo
pnpm macos:demo
```

`pnpm macos:demo` builds and launches **dist/WinTheCloud Studio.app** with the demo library. Select the newest “Why Redundancy Is Not High Availability” project and open **Storyboard** or **Review**.

For your real projects:

```sh
pnpm macos
```

The normal library is `~/Movies/WinTheCloud Studio`. `WTS_HOME` or the app's Settings can select another library. The development app uses this checkout and its `node_modules`; retain both. This is an ad-hoc signed development build, not a notarized distribution bundle.

## The usable workflow

1. Create a project with a title, description, and duration.
2. Paste a script or import plain text. **Save a version**, then **Approve Script**.
3. Drop videos into **Media**, or choose several from the file picker. The app copies each clip and inspects its duration, codec, resolution, frame rate and audio. Import more clips any time before planning.
4. In **Transcript**, load timestamped JSON per clip (see the example; sequential loads bind to the next clip without a transcript), or select OpenAI in Settings and transcribe all pending clips. OpenAI requests are billed to your account; mock mode uses no credits.
5. **Generate Storyboard**. Inspect its scenes, timing, graphics, rationale and provenance. Mock direction is explicitly labelled and uses the demo's deterministic visual pattern; choose OpenAI for real editorial interpretation.
6. **Approve Storyboard**, then **Build Rough Cut**. Watch dependencies, progress, logs and failures in **Production**.
7. Watch the local MP4 in **Review**, jump to a scene, and review the technical QA report. **Open in Resolve** uses the scripting adapter when available. **Resolve Export…** reveals the FCPXML for manual import.
8. Edit a scene through **Inspect / Edit**, or ask the Director for a revision. Inspect the proposed operations and **Apply** or **Reject**. Applying creates a new immutable plan version. Approve that storyboard and rebuild; unchanged assets are reused.
9. Approve the rough cut after reviewing it. Finish and render in Resolve. Publishing is not implemented, and no application command can publish a video.

The MVP supports multiple A-roll recordings per project — imported in order before planning, each with its own transcript — plus 720p/30fps rough cuts, hard cuts, full-frame graphics, modest presenter punch-ins and audio gain. Sources may have another frame rate or resolution, such as 4K/24fps camera files; conformed proxies provide a stable edit timebase and originals are never overwritten. Scenes must cover every imported recording exactly once, in import order, without interleaving. Changing an approved script after media import requires a new project; scene revisions remain available.

## Demo and verification

```sh
pnpm test                 # Unit, domain, IPC and mocked HTTP-provider tests
pnpm test:integration     # Real FFmpeg/proxy/audio and actual Remotion rendering
pnpm demo                 # Full 72-second render + selective rebuild assertions
pnpm typecheck
pnpm lint
pnpm format:check
pnpm macos:build          # Swift release build and local .app bundle
pnpm wts doctor
```

`pnpm demo` writes a new project to `.demo/projects/` and a machine-readable receipt at `.demo/demo-result.json`. It leaves both production-plan versions, both rough cuts, source copies, transcripts, asset metadata, logs/jobs in SQLite, QA and timeline exports. No fixture footage or large rendered video is committed. The safe source fixtures and generator are included in [examples/redundancy](examples/redundancy/README.md).

First Remotion use downloads its official Chrome Headless Shell (~94 MB on this Mac). Subsequent renders can run offline. Demo narration uses macOS `say`; no voice cloning or external media is involved.

## CLI

The CLI and app call the same `Studio` domain service. Run `pnpm wts --help` for the complete command list.

```sh
pnpm wts project create "My video" --duration 900
pnpm wts project list
pnpm wts script import <project-id> ./script.txt
pnpm wts script approve <project-id> --version 1
pnpm wts media import <project-id> ./recording.mov
pnpm wts transcript load <project-id> ./transcript.json
pnpm wts plan <project-id> --provider openai
pnpm wts storyboard <project-id>
pnpm wts plan approve <project-id> --version 1
pnpm wts build <project-id>
pnpm wts jobs <project-id>
```

Always quote paths containing spaces. `render` is an alias for local rough-cut build, not a final Resolve delivery render. Ctrl-C cancels work and retains completed cache entries.

## Credentials

Save the OpenAI key in the app's Settings. Swift uses Keychain Services with a device-local, unlocked-keychain item (`com.winthecloud.studio` / `openai`). The app sends the key to its private child process only when OpenAI is selected; it never writes it to project files. The CLI retrieves the same item through the system Keychain utility. Mock is the default.

The configurable Director model defaults to `gpt-5.4`. Planning and revisions use the Responses API with strict structured outputs and `store: false`. Transcription uses the currently supported `whisper-1` endpoint because segment timestamps are needed for timeline alignment. Audio is compressed to 16 kHz mono MP3; inputs exceeding the upload limit produce an actionable error. Automatic long-audio chunking is not implemented.

## Repository map

| Location                   | Responsibility                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `apps/macos`               | SwiftUI interface, AVKit playback, Keychain, private runtime client                  |
| `packages/orchestrator`    | Domain commands, SQLite, state, jobs, cache, preview, CLI, IPC                       |
| `packages/production-plan` | Strict schema, JSON Schema, inferred TS types, semantic validation, patches          |
| `packages/agents`          | Provider abstraction, mock/OpenAI, Director, transcript validation, future contracts |
| `packages/media`           | Tool detection, safe subprocesses, ffprobe, import, proxy, audio, QA                 |
| `packages/remotion-engine` | Trusted SSR rendering adapter                                                        |
| `templates/remotion`       | Callout, ArchitectureFlow, ChapterTitle, synthetic demo presenter                    |
| `packages/resolve-engine`  | Explicit Resolve probe/import adapter; no GUI automation                             |
| `packages/shared`          | Errors, hashing, safe paths, usage and creator profile                               |

Read [architecture](docs/architecture.md), [development](docs/development.md), [Resolve support](docs/resolve.md), [troubleshooting](docs/troubleshooting.md), [verification evidence](docs/verification.md), and [PROGRESS.md](PROGRESS.md).
