# Verification — September 16, 2026

## Automated checks

| Check                           | Result                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `bun run check`                 | PASS: typecheck, lint, 22 unit/domain/IPC/provider tests                         |
| `bun run test:integration`      | PASS: real FFmpeg inspection/proxy/audio and actual Remotion rendering (2 tests) |
| `bun run demo`                  | PASS: complete 72-second production and incremental rebuild                      |
| `bun run format:check`          | PASS                                                                             |
| `bun run macos:build`           | PASS: Swift release executable and ad-hoc signed .app                            |
| `bun run wts doctor`            | READY for local/mock production; OpenAI credential absent/optional               |
| Apple FCPXML 1.8 DTD            | Generated export validates                                                       |
| Upstream OpenTimelineIO decoder | Reads 3 tracks and 72 seconds                                                    |

The final demo receipt is `.demo/demo-result.json`. The six scenes include two presenter-only scenes, a callout, two architecture animations and a closing title. Four actual Remotion MP4s are generated. Every preview fully decodes with FFmpeg; duration is within 120 ms of the 72-second plan (the native preview reports 72.021354 seconds including AAC padding).

The automated parameter edit changes only scene 002's callout title. Assertions require exactly **1 regenerated / 3 reused graphics** and **1 regenerated / 5 reused preview segments**. The original recording's SHA-256 is unchanged. Two plan versions and renders remain present. API cost is zero because all creative provider calls are mocked.

## Native application

A fresh **Native workflow verification** project was created entirely through the native interface. Verified:

- Script editing, save/version display, and approval gate.
- Native file-picker import and duration/resolution/codec/audio metadata.
- Timestamped transcript import/display.
- Mock Director planning, six storyboard cards, and disabled build until storyboard approval.
- Actual production started from the app; RUNNING, BLOCKED and COMPLETE dependencies and changing progress were visible.
- Successful rough-cut completion, native playback, pause and timeline seeking.
- A revision request targeting scene 002 created a visible proposed `removeGraphic` operation before mutation.
- Apply produced plan v2, cleared storyboard approval and disabled build until reapproval.
- Rebuild reused all three remaining graphics and changed one preview segment. SQLite/file verification confirmed original media and history preservation.
- After the initial native verification, the app showed Gate 2 approval for the native test project and the documented unavailable-scripting message from Open in Resolve. The persisted approval was checked against the preview file hash.
- Native storyboard thumbnail extraction uses an exact nonzero frame so graphics are visible after their entrance animation.

The receipt `.demo/native-verification.json` includes the project ID, preview, source hash result, revision counts, decoded metadata and QA. `bun x tsx scripts/verification-receipt.ts` refreshes that read-only audit when the named local UI-test project exists.

Drop handling is implemented with SwiftUI's file-URL drop destination; the file-picker import path was the route exercised during this run. No real API credential was saved during the UI verification.

## Resolve

Generated FCPXML was imported using Resolve 21.1's supported **File → Import → Timeline** dialog in a newly created **WTS MVP Export Verification** project. The importer recognized 1280×720/30fps. The resulting timeline displayed **00:01:12:00**, V1 presenter clips, four V2 graphic intervals, and A1 narration waveforms. An architecture scene was inspected at approximately 00:30:25 and displayed its title, request flow, shared-database failure emphasis and subtitle. The verification project was saved.

The direct scripting API probe returned no available connection on this installation. No preferences/security access were changed to enable it. Manual FCPXML import is therefore proven; direct scripted import remains a documented optional integration limitation. OTIO was schema-decoded, not separately imported into Resolve.

## Limits of this evidence

Paid OpenAI planning/transcription were not called. The SDK request format, strict schema, token accounting and refusals are tested with a mocked HTTP transport; live model/account availability is a separate gate. Synthetic transcript timestamps match padded segment intervals; they are not word-level forced alignment. Technical QA does not establish factual accuracy or replace creative/audio review.

The automated demo uses test harness approvals and remains awaiting rough-cut review. The separate native test project now has a rough-cut approval recorded in the app. No publication, cloud backend, account registration, analytics retrieval, final store release or notarized distribution was attempted.
