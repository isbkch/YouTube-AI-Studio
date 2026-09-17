# Real-footage rough-cut verification — 2026-09-16

**Verdict: the complete acceptance criterion is not met.** The app has a real, playable, Resolve-imported rough cut with more than five appropriate Remotion graphics. This project's successful render does not prove autonomous editorial production, its A-roll contains confirmed errors, and the Mac app cannot inspect all of the approved plan's decisions.

The attachment was a screenshot, not a video file. It identified the existing project **Your AI-Generated App Is NOT Production Ready**, which was inspected in the authoritative SQLite library, on disk, in the running Mac app, and in Resolve. No source recording, plan, approval, or application code was changed. No paid provider call or new publication was made. One existing saved Resolve project was opened for inspection.

## Acceptance results

| Requirement                                       | Result                                                 | Evidence                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Autonomously generate the editorial plan          | **Not demonstrated by this project**                   | Both saved plans identify `human-director / curated-v1`; the event log records `plan.imported`, not `director.planned`. Usage is empty. Final Cut speech analysis supplied the transcripts.                                                                                                                        |
| Correct A-roll edits                              | **Fail**                                               | Spoken material is missing despite being listed in scene narration; an unrelated earlier take supplies a one-word beat; the saved cut repeats source frames at 29 adjacent boundaries.                                                                                                                             |
| At least five appropriate Remotion graphics       | **Pass for the existing curated cut**                  | Five examples below were checked against narration and sampled rendered frames. All 27 current Remotion assets match their stored output hashes. This does not establish autonomous selection.                                                                                                                     |
| Resolve-ready rough cut                           | **Pass for practical handoff; frame parity has a gap** | Resolve contains the full 1080p/30 timeline, all linked media exists, and a completed final render exists. Four scene-level one-frame differences are reported by the imported timeline API.                                                                                                                       |
| Every decision represented in the Production Plan | **Partial**                                            | Executed source ranges, placements, transforms, audio gains, graphic parameters, chapters, and rationales are present. Rejected/missing sentences, confidence, alternate takes, and bridging decisions are not carried into the plan. Some narration text incorrectly describes speech outside the selected range. |
| Reviewable from the Mac app                       | **Partial**                                            | Playback, seeking, storyboard cards, scene inspection, asset provenance, QA warnings, and revision operations work. The approved plan's source ranges, transcript links, audio gains, and full template parameters are not exposed.                                                                                |

## Verified artifacts

Library project: `~/Movies/yt-ai-studio/projects/your-ai-generated-app-is-not-production-ready-121ad9c9`.

- Nine imported 3840×2160, 23.976 fps recordings, totaling **35:12.125**. Eight are used; the unused short recording is a sound check.
- Plan v2: **113 scenes**, **29,040 frames**, **16:08**, 1920×1080/30. Twenty-seven graphics: 11 ChapterTitle, 10 Callout, two CodeReveal, and one each of FailureAnimation, CodeDiff, Terminal, and MetricChart.
- `renders/rough-cut-v2-42f364af97da.mp4` fully decodes with FFmpeg without errors. Its SHA-256 matches the stored rough-cut approval: `3ba166554a0577d2769ec213ca1892ce3e3ac82990f604c1888ef65f769db883`.
- Plan structure and recording/transcript references pass current validation. Internal timeline clip placements, durations, and A-roll offsets match the stored plan. All 35 FCPXML media references exist.
- Resolve **21.1.0.17** saved project `WTS Final Your AI-Generated App Is NOT Production Ready 2 1789592194630` contains **113 V1 clips, 27 V2 clips, 113 A1 clips**, from frame 0 through 29,040, at 1920×1080/30. No referenced media file is missing. The UI shows the completed render job; `renders/final-v2-H264Master.mov` contains 29,040 video frames at 1080p/30.
- The running Mac app plays and pauses the actual cut. Seeking to approximately 02:10 displayed the incorrect revision graphic described below. Storyboard and Review display the imported-plan provenance and applied patch.
- `bun run check` passes: typecheck, lint, **59 tests**. This does not certify editorial quality. Existing unrelated worktree changes were preserved.

## Confirmed editorial gaps

### 1. Selected audio does not consistently match the approved scene narration

At **03:45.533–03:46.700**, scene-027 claims: “It gives me a Postgres schema. It integrates authentication. It integrates Stripe. It gives me everything.” Its source range is only **C0159 263.067–264.233 seconds** and contains “It gives me everything.” Independent local whisper.cpp transcription confirmed that the original recording contains the Postgres/authentication/Stripe lines immediately before this range, while the rendered cut omits them. These are recorded sentences lost by the edit, not unavailable footage.

At **14:34.333–14:35.200**, scene-099's “Security.” is taken from **C0157 199.233–200.100 seconds**, inside the earlier question about a security vulnerability. This is an unrelated take inserted into the closing checklist. “Failure.” is dropped entirely. The audience question introducing the closing “Is it security? Architecture? Testing?” sequence is also dropped, leaving those prompts without their intended introduction.

The saved plan has **29 adjacent source overlaps totaling 174 frames / 5.8 seconds**. For example, scenes 002 and 003 replay 13 source frames at output **00:07.367**. These counts use actual source-interval intersection; backward take ordering alone was not counted as duplicate footage. The transcript also flags many boundaries within words, but those candidates were not all independently checked and are not counted here as confirmed audible clipping.

Relevant code: [alignment rescue](../packages/orchestrator/src/alignment.ts), [unmatched-sentence bridging](../packages/orchestrator/src/aroll.ts), and [source validation](../packages/production-plan/src/index.ts). Validation checks recording bounds and segment-ID ownership, not whether the selected audio contains the claimed sentence. The aligner's second pass can accept short matches from another take; bridging assigns unmatched text to an inferred interval without proving that text is present.

### 2. The current cut contains an instruction rendered as audience-facing copy

At **02:05.267–02:25.033**, scene-019 displays:

> This stretch is visually flat. Keep my A-roll for the first sentence, then illustrate the

The applied range revision copied the creator's direction into a Callout title, truncated it, and covers the entire scene. It does not preserve the first sentence on camera or illustrate the friction story. This was confirmed in both an extracted frame and native playback, not inferred solely from JSON.

The [range parser](../packages/orchestrator/src/studio.ts) still has a fallback that uses `request.slice(0, 90)` as graphic copy. Its compound “first sentence” handling operates on whole scenes, so it cannot reliably implement a within-scene change of treatment.

### 3. Graphic count does not establish factual or contextual quality

These five existing graphics pass the requested contextual spot check:

| Output time         | Scene / template       | Why appropriate                                                                                     |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| 01:00.400–01:04.433 | 011 / FailureAnimation | Highlights database failure while the narration asks what happens when the database is unavailable. |
| 04:13.300–04:18.000 | 032 / Callout          | Reinforces that a working happy path does not establish production readiness.                       |
| 06:15.733–06:30.700 | 046 / CodeReveal       | Shows the document lookup without an ownership check while that vulnerability is explained.         |
| 09:34.133–09:42.800 | 072 / Callout          | Distinguishes having backups from testing a restore.                                                |
| 10:17.467–10:38.367 | 075 / Callout          | Maps RPO/RTO to the two questions being spoken.                                                     |

However, scene-105 at **15:00.100–15:07.033** charts `1, 2, 4, 8, 16, 32 ×`, although the narration provides no such measured series and the visual is not labeled hypothetical. Scene-037's “Idempotency, not hope” example checks for an existing job and then calls the model before recording completion; the displayed logic does not itself prevent concurrent duplicate calls or retries after a crash between those steps. Both need editorial correction.

### 4. The Mac inspector does not expose the complete plan

[ProductionScene](../apps/macos/Sources/YTAIStudio/Models.swift) does not decode `sourceInFrame`, `transcriptSegmentIds`, `audio`, or `transition`. Its graphic parameters omit fields such as code lines, chart series, architecture layers, and failed-node selection. The [scene editor](../apps/macos/Sources/YTAIStudio/ProductionViews.swift) offers only Presenter, Callout, ArchitectureFlow, and ChapterTitle, although the catalog has eleven graphic templates.

The FailureAnimation inspector was checked in the running app: narration, title/subtitle, punch-in, enabled state, and asset provenance are visible; the selected source interval and failure-node parameters are not. The separate A-roll draft screen can show draft timings and dropped text after computation, but that recomputed draft is explicitly superseded by the approved Director plan. It is not a complete audit of the selected plan.

### 5. Resolve import is real, but exact frame parity needs tightening

Against the internal timeline, Resolve reports scene-033 as **240 frames instead of 241**. Source start is one frame earlier for scenes 037 (**2034 vs 2035**), 050 (**8124 vs 8125**), and 095 (**983 vs 984**). Each difference occurs on both video and narration. All graphic starts/durations match. This is a frame-parity finding from the Resolve API, not a claim that the entire import failed. The rough-cut MP4 also reports 29,039 video frames across the nominal 968-second interval, whereas the final Resolve render reports 29,040.

The handoff uses conformed 1080p media, not automatic reconform to the original 4K footage.

## What today's autonomous planner produces

A fresh, isolated invocation of the current `alignScript` and `DirectorAgent(MockAIProvider)` used the same script, recordings, and transcripts without changing the real project. It returned a valid **110-scene, 15:35.9 plan with 27 graphic instructions and no adjacent source overlap**. Thus today's source improves the saved cut's overlap problem; the existing approved v2 is not evidence that those improvements have been rendered.

The fresh plan still reproduces the missing Postgres/authentication/Stripe speech and the unrelated “Security” selection. Its graphics are keyword rules: for example, the explanation of looking up a document by ID receives the generic “Redundant front ends, one failure domain” database diagram. It is a deterministic draft, not verified semantic direction. This candidate was not approved, rendered, or imported into the real project. The live OpenAI Director remains untested in this audit.

Normal planning reuses stored alignment when present; a separate run using this project's stored alignment produced a different 125-scene candidate. Alignment algorithm identity is not part of that stored artifact, so testing a fresh alignment and testing the existing project path are distinct checks.

## What remains before this criterion can pass

1. Correct take selection and sentence boundaries, preserving recorded material or explicitly recording every intentional omission; validate the selected audio against narration.
2. Generate an in-app Director plan without external manual graphic curation, and inspect its real graphic content. Preserve creator approval gates.
3. Replace instruction-to-title fallback behavior with a concrete scene/subscene proposal; ground chart values and technical examples in the narration or label them illustrative.
4. Carry omission reasons, confidence, alternative takes, and script coverage into the versioned review artifact; expose full source ranges and all template parameters in the Mac app.
5. Resolve the frame differences, rebuild a new version through the normal approvals, then check that version's speech, graphics, Mac playback, and Resolve timeline together.

Local evidence is retained in [`.cache/verification/2026-09-16-real-footage`](../.cache/verification/2026-09-16-real-footage): scene/transcript comparison, fresh candidate plan, output probes, Resolve clip inventory, hash audit script, FFmpeg decode log, check log, sampled frames, and local speech-recognition samples. This ignored evidence directory contains local project material and is not added to Git. No full human listening pass, live paid-provider run, or fresh end-to-end render of the candidate was performed.
