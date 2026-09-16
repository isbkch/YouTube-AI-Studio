# WinTheCloud Studio — implementation progress

## Completed

- Established the monorepo, shared domain types, strict production-plan and patch schemas, generated JSON Schema, state transitions, SQLite metadata, local project files and CLI.
- Implemented non-destructive recording import, actual ffprobe inspection, conformed 720p/30fps proxies, extracted audio, duration verification and full-decode QA.
- Added multi-clip A-roll: imports stay open until planning, transcripts bind per recording (explicit ID, embedded ID, or next clip without a transcript), transcription loops pending clips, and plans must cover every recording in import order with per-clip transcript scoping. Verified with a real two-recording end-to-end build.
- Implemented typed mock/OpenAI providers, Responses structured output, timestamped transcription, Director planning, scoped revision proposals and usage tracking.
- Implemented persistent job graphs, dependency validation, concurrency, cancellation, recoverable retries, explicit crash recovery, verified content-addressed caching and asset provenance.
- Rendered actual Callout, ArchitectureFlow and ChapterTitle Remotion graphics. Built per-scene FFmpeg previews, local rough cuts, internal timelines, FCPXML and OTIO exports.
- Built and launched the SwiftUI app with projects, script/version approval, media import/drop handling, transcript, storyboard/editor, live production queue, native AVKit playback, Director proposals, Settings, Keychain integration and editable creator preferences.
- Exercised the native workflow from a newly created project through script approval, video/transcript import, planning, storyboard approval, real rendering, playback, a scoped revision, reapproval and selective rebuild.
- Generated the complete 72-second demo with four graphics. The parameter revision regenerated exactly one graphic and one preview segment, reusing three graphics and five segments. Original recording hash unchanged.
- Verified the native removal revision separately: one changed preview segment, three reused remaining graphics, two preserved plan/render versions, source hash unchanged.
- Validated FCPXML 1.8 against Apple's installed DTD and decoded the three-track, 72-second OTIO with the upstream library.
- Imported generated FCPXML into Resolve 21.1, inspected the 72-second V1/V2/A1 timeline and an architecture scene, and saved the isolated `WTS MVP Export Verification` project.
- Passed `pnpm check`: TypeScript, ESLint and **22 tests**. Passed **2 actual media/render integration tests**, `pnpm demo`, Prettier checks and Swift release build.
- Added README, setup/development/troubleshooting/verification documentation and all seven requested ADRs.

## In Progress

- None required for the functioning MVP. The automated demo rough cuts remain awaiting review. The native test project now has rough-cut approval recorded in the app.

## Next

- Creator review of the demo and a first real-footage project.
- Configure an OpenAI API key in Settings to verify live account/model access and transcription (paid requests were not made during development).
- Future work: original-resolution reconform/final-render automation, distribution packaging/notarization, more reusable templates, optional Blender/Fusion/image production, then research/publishing/analytics behind their human gates.

## Known Issues / Deliberate MVP Limits

- Multiple A-roll recordings per project (imported before planning, in order); 1280×720/30fps previews; hard cuts, full-frame graphics, numeric punch-ins and audio gain.
- Script editing is locked after media import; use scene revisions or create a new project for a new script.
- Real OpenAI calls and Keychain save/read with a real credential were not exercised. Provider transport/structured output/refusal handling is tested with mocked HTTP.
- Resolve's external scripting probe could not connect on this installation. Direct adapter import is implemented against the installed vendor API but unverified here; **manual FCPXML import is verified**. No security preferences were changed.
- OTIO does not apply camera sizing/audio gain universally; use FCPXML for those properties.
- Technical QA checks media/timing/provenance and reports silence/peaks. Factual accuracy, text fit, mix and creative judgment still require review.
- Audio uploads over the configured size limit require transcript import; no automatic chunking yet.
- The ad-hoc signed development app requires this checkout, installed dependencies and Node. It is not a standalone notarized release.
- Historical/cache files are retained; no automatic deletion or cache eviction.
- Verified on macOS 27 arm64/Swift 6.4/Node 26.8.2/FFmpeg 9.0.1. Other supported Mac versions are not device-tested.

## Architectural Decisions

1. SwiftUI control plane + TypeScript/Node domain runtime; CLI shares domain logic.
2. Private child-process JSON-lines IPC; no application HTTP daemon or cloud infrastructure.
3. Versioned strict plan, integer frames, validated source references and explicit immutable patches/undo.
4. SQLite-persisted DAG, bounded concurrency, process ownership locks and content-verified cache.
5. Independent timeline abstraction; local preview and FCPXML/OTIO handoff.
6. Local media/files + WAL SQLite metadata + macOS Keychain credentials.
7. Trusted parameterized engine adapters; models never generate executable shell/Python/JavaScript instructions.

See `docs/adr/` for rationale and consequences.

## How to Run

```sh
pnpm install
pnpm check
pnpm test:integration
pnpm demo
pnpm macos:demo   # native app + demo library
pnpm macos        # normal local project library
pnpm wts doctor
```

The app is `dist/WinTheCloud Studio.app`. Default user library: `~/Movies/WinTheCloud Studio`; demo library: `.demo`. The newest demo's exact output paths and cache assertions are in `.demo/demo-result.json`. Native workflow evidence is in `.demo/native-verification.json`. See `docs/verification.md` for the proof boundaries.
