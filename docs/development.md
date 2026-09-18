# Development and dependencies

Use Node 24+ for the built-in SQLite API. The checked lockfile pins the resolved dependency graph. All Remotion packages are aligned at exactly 4.0.525. React renders trusted templates; OpenAI SDK 7.15.0 handles current Responses/Audio calls. Zod supplies runtime validation, TypeScript inference and JSON Schema generation. ESLint and Prettier cover TypeScript/JSON; `bun run swift:format` uses the Swift toolchain formatter.

The local build was verified on macOS 27 arm64, Swift 6.4, Node 26.8.2, Bun 1.4.2 and FFmpeg 9.0.1. Swift source targets macOS 14+, but other OS/toolchain combinations have not been device-tested. The app uses an explicit AVPlayerView bridge because the preview OS's SwiftUI VideoPlayer failed at runtime despite a successful build.

## Useful loops

TypeScript runs side by side: `@typescript/native` aliases TypeScript 7 and provides `tsc` for typechecking; `typescript` aliases the TypeScript 6.0 compatibility package for ESLint's compiler API. Keep the API dependency on 6.0 until typescript-eslint supports the newer API. This follows the [TypeScript migration guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0).

```sh
bun run check
bun run test:integration
bun run schema
bun run format
bun run swift:format
bun run macos:build
bun run demo
bun run macos:demo
```

The app starts a Node child with `--import tsx` and the checked-in IPC entrypoint. Changes to the runtime require restarting the app. The app bundle embeds a reference to the checkout; rebuilding refreshes that path. Release packaging should bundle a supported Node runtime, compiled JS and production dependencies, then add hardened runtime signing/notarization. Current local signing is ad hoc and no distribution certificate is needed.

A configured `WTS_<TOOL>_PATH` overrides PATH lookup. Otherwise the runtime searches PATH and common executable locations, and checks application bundles for Blender/Resolve. `WTS_RESOLVE_APP` overrides the Resolve bundle. `WTS_HOME` selects the project library. These are configuration values, not model outputs. There is deliberately no arbitrary command setting in the UI or plan schema.

## Tests

`bun run test` covers plan validation, state gates, canonical hashes, path traversal/symlinks, persisted locks, retry/dependency/cancellation behavior, immutable patches/undo, transcript timing, timeline construction, cache corruption, a real stdio IPC process, and OpenAI SDK requests with a completely mocked HTTP transport. These tests spend no credits.

`bun run test:integration` produces actual short FFmpeg media and a Remotion graphic, then fully decodes the outputs. It requires local tools and may download Remotion's official browser on first use. `bun run demo` is the full end-to-end test: assertions verify media duration, graph execution, four rendered graphics, incremental cache reuse and unchanged source hash. Each run creates a new project so previous evidence remains intact.

For thumbnails, `node --import tsx --test tests/thumbnails.test.ts tests/thumbnails-ipc.test.ts` covers persistence, retries, cancellation, approval integrity, exact exports and mocked YouTube CLI failures. `node --import tsx --test tests/thumbnails.integration.ts` renders the actual still template, checks decoding and dimensions, exercises headline overflow and verifies exported hashes. Set `WTS_THUMBNAIL_VERIFY_ROOT` to an explicit disposable directory to retain that integration fixture for native UI checks. None of these tests calls a paid image provider or uploads to YouTube. Use `swift build --package-path apps/macos -c release` to compile without replacing the installed development app.

FCPXML can additionally be validated against the DTD shipped with Final Cut Pro. Copy the DTD to a path without spaces before passing it to `xmllint --dtdvalid` on macOS; the system libxml parser did not resolve the spaced DTD path directly. OTIO can be decoded with the upstream Python package:

```sh
uv run --with opentimelineio python -c 'import opentimelineio as o,sys; t=o.adapters.read_from_file(sys.argv[1]); print(t.duration(), len(t.tracks))' /absolute/path/to/export.otio
```

## Dependency and licensing notes

FFmpeg must include `libx264` and `libmp3lame`; Doctor detects executables and versions, while render failures identify missing encoders. Remotion includes its own rendering helpers and an official Chromium download. It has its own [license terms](https://www.remotion.dev/docs/license); review them for your organization before distribution or commercial scaling. Resolve's licensing and scripting permissions are independent of this app. Blender is optional and not invoked by the MVP.

Primary implementation references, inspected September 16, 2026:

- [Remotion Node SSR](https://www.remotion.dev/docs/ssr-node)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI transcription and timestamps](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Node SQLite](https://nodejs.org/api/sqlite.html)
- [FFmpeg CLI](https://ffmpeg.org/ffmpeg.html)
- [Apple Process](https://developer.apple.com/documentation/foundation/process)
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)
- [Apple FCPXML](https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference)
- [OpenTimelineIO file format](https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-file-format-specification.html)
- Resolve 21.1 installed vendor `Developer/Scripting/README.md` (updated August 31, 2026) and `DaVinciResolveScript.pyi`.

A fresh worktree also needs the locally ignored `docs/video-script-example.md` fixture from the existing checkout for `tests/m4.test.ts`; do not synthesize a replacement or edit the original file.
