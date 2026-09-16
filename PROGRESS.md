# WinTheCloud Studio — implementation progress

## Completed
- Inspected empty repository and local environment: macOS 27 arm64, Swift 6.4, Node 26.8.2, pnpm 10.24, FFmpeg 9.0.1, Resolve 21.1.
- Read current Remotion SSR / OpenAI structured output and transcription documentation, and installed Resolve scripting reference (31 Aug 2026).
- Established pnpm monorepo and verification commands.

- Foundation: strict schema + generated JSON Schema, frame semantics, patches, state machine, SQLite storage.
- Media: real FFprobe inspection, non-destructive import, 720p CFR proxies, extracted audio.
- AI: mock + OpenAI Responses structured-output providers; timestamped transcription and scoped revision proposals.
- Jobs: persistent dependencies, concurrency, cancellation, retries, logs, verified content cache and provenance.
- Actual Remotion ArchitectureFlow, Callout and ChapterTitle rendering; FFmpeg assembly; internal timeline, FCPXML and OTIO exports.
- First complete 72-second demo passed full decode and duration QA. Incremental revision regenerated 1/4 graphics and 1/6 segments; source hash unchanged.
- Shared CLI and private stdio service; environment Doctor.

## In Progress
- Native SwiftUI app compilation, launch, and UI verification.
- Resolve import verification and export format checks.
- Recovery/security edge cases, integration tests and final documentation.

## Next
1. Verify foundation tests.
2. Import/inspect actual media; create synthetic demo footage and transcript.
3. Provider abstraction and Director, primarily verified with mock responses.
4. Persistent jobs, content-addressable Remotion renders, internal timeline, FFmpeg preview.
5. Produce and inspect complete demo media and incremental rebuild.
6. Build and launch SwiftUI app over the same domain service.
7. Resolve import/export verification and documentation/polish.

## Known Issues
- Blender 5.2.2 LTS detected in its app bundle (not on PATH); optional and outside MVP.
- Resolve scripting access depends on edition/preferences and an active application. Export and preview must work independently.
- Paid AI requests are not needed for development; live provider verification will be distinguished from mock tests.

## Architectural Decisions
- SwiftUI control plane + Node/TypeScript domain runtime, private stdio JSON-lines IPC.
- Integer frames at a declared frame rate; source timing and timeline timing are distinct.
- Zod schemas generate JSON Schema and TypeScript types; semantic validation runs before execution.
- SQLite is metadata authority; media lives on disk. Versioned artifacts and human approvals bind to exact versions.
- Render cache identity excludes plan version; provenance includes the plan/scene/job that reused or generated it.

## How to Run
- `pnpm install`
- `pnpm check` (as implementation becomes available)
- `pnpm demo` for the full credit-free pipeline
- `pnpm macos` to build and launch the local app
