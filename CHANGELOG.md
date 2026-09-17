# Changelog

Notable changes to yt-ai-studio are documented here. Releases are
numbered from `package.json`; while pre-1.0, expect breaking changes between
alphas without a major-version bump.

## [0.1.0] — 2026-09-17

First public alpha. yt-ai-studio is a native macOS production dashboard for technical YouTube videos: a SwiftUI app and a CLI (`wts`) sharing one local TypeScript runtime that takes you from idea to uploaded video — with a human approval gate at every stage and no cloud backend. The pipeline ingests real camera files, aligns your approved script against every take, builds a deterministic edit, renders a 1080p/30 rough cut, finishes through Resolve, and publishes through your own local YouTube CLI. Mock providers are the default, so the whole workflow runs without any API keys.

### Pre-production

- **Research agent** distils the idea into an evidence brief: key points,
  labelled claims, steelmanned counterpoints, and canonical sources to verify.
- **Narrative agent** shapes the brief into a sectioned outline with per-section
  beats and second budgets.
- **Script agent** drafts the full shooting script in the A-roll/B-roll format;
  hand-writing or pasting a script at any point works just as well.
- **Pre-visualization** directs the edit before you record: a chronological
  shot plan with a regrouped recording order and prep notes, bound to the
  script version and visibly stale after edits.
- **Teleprompter** renders the approved script into a reading document with
  spoken paragraphs, bracketed crew cues, and a run sheet.

### Media, transcripts, and the deterministic A-roll edit

- Import camera files of mixed resolution and frame rate (4K/23.976 verified);
  originals are copied and never modified. Conformed 1080p proxies give the
  edit a stable frame count.
- Word-level transcripts from Final Cut speech analysis (`.fcpbundle`),
  timestamped JSON, local whisper.cpp (free, offline), or OpenAI. Same-length
  retakes are disambiguated by fingerprinting their first spoken words.
- Script↔take alignment feeds a deterministic A-roll draft: take selection,
  dead-space removal, punch-ins, retakes and false starts on the cutting room
  floor — with a dropped-sentences report and a per-recording coverage report.
- Editorial honesty is enforced, not promised: the same recording's source
  ranges never overlap, each scene's narration must be spoken inside its
  selected range, and transcript references must point into that range.

### Planning, graphics, and generated media

- Storyboards from an 11-template Remotion catalog rendered at 1080p/30, or
  import a hand-authored plan through the same strict validation
  (production-plan schema v4.2.0, JSON Schemas checked in).
- Revisions are typed patches: apply or reject through the UI or CLI, with
  immutable plan versions and automatic invalidation of downstream approvals.
  Time-range revisions (`3:42-4:10 "illustrate the failover"`) never turn a
  creator instruction into audience-facing copy.
- Generated B-roll from mock gradients, OpenAI `gpt-image-1`, or Gemini Nano
  Banana stills, turned into deterministic motion clips with inset placement
  over the live presenter.
- Music beds from your curated library, local synthesis, or Gemini Lyria
  generation, sidechain-ducked under the narration; per-scene music intensity.
- Six headless Blender EEVEE templates (NetworkFlow, ServerRack, OrbitRings,
  CascadeGrid, DataTunnel, TerrainSweep) for 3D B-roll. Every generated-media
  engine follows the trusted-adapter contract and fails closed when
  unavailable.

### Review, finishing, and publishing

- Watch the rough cut locally, jump scene to scene, and read the automated QA
  report: decode/duration checks, black/freeze detection, and per-scene vision
  verdicts against each scene's intent.
- Approving the rough cut starts the final render autonomously: Resolve first
  with a validated preset and optional checked-in Fusion macros, falling back
  to a verified FFmpeg render (recorded in `finalRenderEngine`).
- Export engine-neutral timelines: FCPXML, OpenTimelineIO, and chapter lists.
- **Packaging agent** proposes ranked titles, thumbnail concepts, a description
  with the exact chapter timestamps of the rendered timeline, and upload
  metadata. It may only re-title chapters, never re-time them.
- Publishing uploads through your local `youtubeuploader` CLI (argument arrays,
  no shell, OAuth handled by the CLI itself) only after approval of the exact
  packaging document hash — one-shot, recorded, private visibility until you
  flip it in YouTube Studio.

### Engineering

- The SwiftUI app and the CLI call the same domain service and enforce the
  same gates: script approval → media import → transcripts → storyboard
  approval → build → rough-cut approval → final render → packaging approval →
  publication, each bound to a hash of the exact artifact.
- SQLite (WAL) persistence with per-project locks, dead-owner recovery
  (`wts project recover`), and hash-verified caches that make selective
  rebuilds safe.
- 88 tests: domain, IPC, jobs, and mocked provider suites (`bun run check`), a
  real-media integration suite (`bun run test:integration`), and a
  credit-free end-to-end demo with selective-rebuild assertions
  (`bun run demo`). CI runs the check suite and the Swift release build.
- MIT licensed; runs local-first with no server components.

### Requirements

macOS 14+, Xcode command-line tools with Swift 6+, Node.js 24+, Bun 1.4+,
and FFmpeg/ffprobe with `libx264` and `libmp3lame`. Optional: whisper.cpp,
DaVinci Resolve, Blender, and `youtubeuploader` for publishing.

```sh
bun install
bun run check      # typecheck + lint + 88 mocked tests
bun run demo       # end-to-end synthetic production, no API keys
bun run macos:demo # build and launch the app with the demo library
```

### Alpha limitations

- Previews and builds render 1920×1080 at 30 fps only; hard cuts only
  (numeric punch-in is the one implemented transform). The plan schema
  accepts more than the media layer currently executes.
- macOS only. The bundled app is an ad-hoc signed development build — not
  notarized — and references your checkout; build from source with
  `bun run macos:build`.
- Jobs do not resume automatically after a crash; `wts project recover` is the
  explicit entry point.
- The script locks once media is imported; a published project is one-shot.
- Pre-production agents write from model knowledge without browsing: their
  sources are citations to verify, not retrieved pages.
- Integration and demo runs (real FFmpeg/Remotion renders) are not part of CI
  and require local media tools; there is no Swift test target yet.

[0.1.0]: https://github.com/isbkch/yt-studio/releases/tag/v0.1.0
