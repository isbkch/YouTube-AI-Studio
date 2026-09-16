# WinTheCloud Studio — implementation progress

## Completed

- **Milestone 4 — pre-production agents (2026-09-16).** What happens before recording is now agent-assisted end to end: **Research** (evidence brief with labelled claims and canonical sources) → **Narrative** (retention-shaped outline with per-section purpose/beats/second budgets) → **Script Agent** (full A-roll/B-roll draft in the `docs/video-script-example.md` shooting-script format, saved as a normal script version) → **Director pre-visualization** (a chronological shot plan with planned timecodes — `06:30 — deliver on camera: …` — plus a regrouped recording order and prep notes) → the existing script-approval gate → **teleprompter** (reading document with bracketed crew cues; the run sheet rides along when the pre-visualization matches the current script version). CLI: `wts research | narrative | script draft | previsualize | teleprompter`; native app: the Pre-Production tab walks the same pipeline. Every stage is a cancellable persisted job with usage accounting; outputs are validated schemas (`research_notes`/`narrative_outline`/`video_script`/`previsualization`), artifacts live under `research/` and `scripts/`, and the mock provider is fully deterministic (topic-matched canonical sources, budgeted outline, parsed-structure shot plan). The lenient script parser also accepts hand-edited scripts, so pre-visualization and the teleprompter keep working after manual rewrites; pre-visualization binds to a script version and goes stale visibly when the script changes. 5 Milestone-4 unit tests plus IPC and provider-transport coverage (50 tests total).
- **Milestone 3 — production quality (2026-09-16).** The decision layer is a first-class pass: a `VisualPassAgent` decides whether the video needs a generated visual, what it must communicate, where it belongs, how long it lasts and which narration span it illustrates, then proposes `setBroll`/`setAudioDesign` patch operations through the existing human gate (`wts visuals propose`, Storyboard **Propose Visual Pass**). GPT-image generation (gpt-image-1) renders stills from validated briefs through trusted prompt assembly, with deterministic zoompan/pan motion, inset compositing over live presenter footage, full-frame replacement, and per-still/per-clip caching keyed on semantic identity. Music/SFX come from a creator-curated library manifest (`library/library.json`) and are mixed under narration with sidechain ducking (`amix` + `sidechaincompress` + limiter) at assembly, exported as FCPXML music/effects lanes and OTIO audio tracks. Automated visual QA: black/freeze detection, sampled mid-scene frames reviewed by a vision model (multimodal Responses input) against each scene's intent, generated-still brief gates, and a QA report v2 with per-scene verdicts and an `attention` list surfaced in Review. Resolve finishing: headless render-queue automation with validated presets and optional checked-in Fusion macros (`wts final render`, Review **Finishing**). Plan schema v3.0.0 (broll + audioDesign + migration from v1/v2), timeline schema 1.1.0 (v3 B-roll insets, a2 music, packed SFX lanes), `Usage.imageCount` accounting, engine capability advertisement with fail-closed execution (ADR 008).
- **Milestone 2 — real footage pipeline (2026-09-16).** One autonomous rough cut from the real 2026-09-13 A-roll (nine 4K/23.976 takes, ~34 min): word-level transcripts imported from Final Cut speech analysis (3,536 words, take mapping by duration + whisper fingerprint for same-length retakes), script↔take alignment (191/201 sentences at 0.90 average score), deterministic A-roll edit (113 scenes, 16:08 kept, retakes/dead space dropped), human-curated Director plan imported through full validation (26 graphics from the 11-template catalog, 11 chapters), 1080p/30 rough cut, Resolve FCPXML/OTIO + YouTube chapters exports, and scoped range revisions.
- Plan schema v2: discriminated 11-template graphic catalog with per-template parameters, sub-range scene sources (take selection instead of full-coverage), chapter titles, v1 plan auto-migration.
- Milestone-2 stages surfaced in the native app: Final Cut analysis import, the deterministic A-roll draft with per-scene summary, plan JSON import, and timeline-range revisions in Review. Every catalog template is now render-verified by an integration test, and the A-roll editor de-overlaps padded alignment spans so a cut never presents source seconds twice or exceeds its sources.
- Transcription providers split: mock / local whisper.cpp (free) / OpenAI (word+segment timestamps); `.env` OPENAI_API_KEY credential resolution ahead of Keychain.
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
- Passed `bun run check`: TypeScript, ESLint and **44 tests** (8 Milestone-3 unit tests) plus **5 media/render integration tests** (generated-still → motion → inset composite → sidechain mix). `bun run demo` proves the full Milestone-3 loop credit-free: visual pass proposes 2 insets + a synthesized music bed, mock gpt-image renders stills with motion, segments composite insets over the presenter, the bed is mixed with ducking, and visual QA passes with sampled frames on disk. Prettier checks and the Swift debug build pass.
- Added README, setup/development/troubleshooting/verification documentation and all seven requested ADRs, plus ADR 008 (generated media, curated audio, budgets, QA gates).

## In Progress

- None required for the functioning MVP. The automated demo rough cuts remain awaiting review. The native test project now has rough-cut approval recorded in the app.

## Next

- Creator review of rough cut #1 in the app (`~/Movies/WinTheCloud Studio`, project "Your AI-Generated App Is NOT Production Ready", latest: `renders/rough-cut-v2-42f364af97da.mp4`, 1920×1080/30, 16:08). Two dropped sentences and pacing notes go through `wts revision range`.
- Run `wts visuals propose --provider openai` on the real project once an API key is configured: the live visual pass (gpt-5.4 + gpt-image-1) has not been exercised against real footage yet — mock-provider demo coverage is complete, live calls are not.
- Resolve final render (`wts final render`) remains unverified on this machine: the external-scripting probe could not connect during Milestone 2. The bridge implements the documented API; the manual FCPXML path is the verified fallback.
- Curate a real music/SFX library (`~/Movies/WinTheCloud Studio/library/library.json`): the demo bed is synthesized; real tracks with cleared licenses are the creator's contribution.
- The pre-production agents are mock-verified end to end (CLI, IPC and unit tests); the live OpenAI path for `research`/`narrative`/`script draft`/`previsualize` follows the same tested transport as the Director but has not been exercised against a real key yet — same caveat as the live visual pass.
- Future work: Blender engine adapter (the registry, capability manifest and broll asset union are the whole integration surface — see ADR 008), original-resolution reconform for finals, distribution packaging/notarization, then publishing/analytics behind their human gates.

## Known Issues / Deliberate MVP Limits

- Multiple A-roll recordings per project (imported before planning, in order); 1920×1080/30fps previews; hard cuts, full-frame graphics from the 11-template catalog, numeric punch-ins and audio gain; scenes are sub-ranges, so unused takes are simply omitted (QA reports coverage).
- Alignment is fuzzy-match based: rare sandwiched sentences are bridged by audio rather than cut; two sentences remained unmatched in the real run.
- Range revisions parse deterministic intents (keep A-roll / illustrate / chapter / punch-in); free-form chat direction still needs the OpenAI Director.
- Final Cut transcript import requires the library's speech analysis to have run; local whisper.cpp needs `whisper-cli` + a ggml model.
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
bun install
bun run check
bun run test:integration
bun run demo
bun run macos:demo   # native app + demo library
bun run macos        # normal local project library
bun run wts doctor
```

The app is `dist/WinTheCloud Studio.app`. Default user library: `~/Movies/WinTheCloud Studio`; demo library: `.demo`. The newest demo's exact output paths and cache assertions are in `.demo/demo-result.json`. Native workflow evidence is in `.demo/native-verification.json`. See `docs/verification.md` for the proof boundaries.
