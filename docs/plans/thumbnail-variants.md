# Thumbnail rendering and A/B variants

Status: implemented on `codex/thumbnail-variants` in the separate `yt-studio-thumbnails` worktree. The design below records the approved scope. Source inspected September 17, 2026; validation is recorded in `docs/thumbnail-verification.md`.

## Product decision

Turn the Packaging agent's existing thumbnail concepts into two finished images. The creator compares A and B, makes small edits, exports both, and optionally chooses one for the existing upload flow. The user confirmed that live experiments stay in YouTube Studio.

Keep this a packaging feature: one explicit **Render A/B** action, two image-generation requests, deterministic text composition, and the existing publication approval. No new agent, background automation, production-plan version, or human gate.

## What already exists

| Existing surface                                 | Reuse                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agents/src/packaging.ts`               | Two to four concepts with `id`, `headline`, `direction`, and `emotionalHook`.                                                                                       |
| `packages/image-engine/src/index.ts`             | `ImageProvider.generate()` for mock, OpenAI, and Gemini; usage and cancellation. The request accepts text only, with no reference portrait or image-edit interface. |
| `packages/remotion-engine/src/index.ts`          | Bundling, composition selection, and `renderStill()` already used for placeholders.                                                                                 |
| `packages/orchestrator/src/studio.ts`            | Packaging after final render, project locks, persisted operations, usage, and approval.                                                                             |
| `packages/orchestrator/src/youtube.ts`           | `publishToYouTube()` already accepts `thumbnail` and emits `-thumbnail`; `Studio.publish()` does not yet supply it.                                                 |
| `apps/macos/Sources/YTAIStudio/ReviewView.swift` | Packaging & publishing card, currently showing concepts as text inside the narrower review column.                                                                  |

The incremental work is the thumbnail artifact contract, a still composition, and native review controls. A new image service or experiment system would expand this beyond a small feature.

## Creator workflow and UI

1. Generate Packaging as today. Under its title, replace the concept list with a **Thumbnails** section. Default A and B to the first two distinct concept IDs; each can use another existing concept. Keep the proposed video title the same for both.
2. Show two compact concept cards with headline and a one-line angle. **Render A/B** names the actual image provider and says “2 images”; mock mode says “Mock previews.” Do not generate images automatically when packaging completes or a view opens. Missing provider credentials link to existing Settings.
3. Render sequentially and persist each result independently. Show “Rendering A · 1 of 2,” then B. A successful image remains visible if B fails; offer **Retry B**. Cancellation preserves completed work. Reopening the app restores each slot's state.
4. Once available, each card shows the actual 16:9 image. **Compare & edit…** opens a native sheet around 960 points wide, independent of the narrow Review split view. Use the existing light surfaces, thin borders, serif section heading, terracotta primary action, and green selected-state label. Keep the project navigation unchanged.
5. The sheet places A and B side by side at equal size. A **Large / Feed size** control compares the same images at roughly 400 and 240 points wide; clicking an image opens a full-resolution preview. Show the same video title below both, with a preview-only duration badge at bottom right. Selection has both a border and “Selected for upload” text.
6. Each variant has **Edit…**, exposing only headline and visual direction. **Apply headline** recomposes locally. **Regenerate image** makes one new image request; changing direction requires that action. Keep old successful revisions available through a small “Previous versions” menu. No canvas, layers, font controls, or crop editor in v1.
7. **Use A for upload** or **Use B for upload** pins the exact rendered revision. “No custom thumbnail” remains an explicit valid choice. The packaging card shows the choice next to the current publication approval.
8. **Export A/B…** uses a native destination picker and writes both images into a new export folder, plus a small manifest mapping A/B to their concepts and revisions. Require two current, ready images for the pair export. **Reveal** on an individual card remains useful when only one is ready. Retain export access after publication.
9. Approve Packaging and Publish as today. The selected image travels with the upload. After publication, **Open YouTube Studio** and **Export A/B…** support the manual experiment handoff; thumbnail editing/selection is read-only in this first version.

No performance score, predicted CTR, “winner,” or “test running” badge belongs in this UI. “Selected” means the creator's upload choice, not experimental evidence.

### States worth designing explicitly

| State                 | What the creator sees and can do                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No packaging          | “Generate packaging to create thumbnail concepts.”                                                                                                      |
| Concepts ready        | A/B text cards and Render A/B, with provider and image count.                                                                                           |
| Rendering             | Per-slot stage and Cancel; existing successful images remain visible.                                                                                   |
| One failure           | The successful variant, an error on the other, and Retry for that slot. Selection of the successful variant remains possible.                           |
| Unapplied edit        | Draft text is separate from the saved image; Apply headline or Regenerate image makes a new revision. Closing with edits offers Keep editing / Discard. |
| Both ready            | Equal-size previews, comparison, selection, and pair export.                                                                                            |
| Packaging regenerated | Prior images remain in history and are labeled as belonging to an older package. Current selection clears; Render A/B prepares the new package.         |
| Approval invalidated  | “Thumbnail changed. Review and approve packaging again.” No stale approval badge.                                                                       |
| Published             | Uploaded choice is frozen; compare, reveal, export, and Studio link remain available.                                                                   |

## Rendering contract

- **One fixed composition:** text on the left over a contrast scrim; one generated subject on the right; project brand colors and font from the snapshotted creator profile. A/B varies the concept and headline, not the entire layout system.
- Generate a text-free background using the existing landscape `1536x1024` request at medium quality. Its prompt includes the topic, concept direction, emotional hook, brand palette, empty left text area, and safe placement for the 16:9 crop. Conform with center crop and scale; do not stretch.
- Composite the exact headline with a checked-in `YTAIStudioThumbnail` Remotion composition. Aim for three to six words, allow the existing 50-character maximum, fit at most two lines with a defined minimum font size, and reject overflow with an actionable edit message. Never silently shorten or ask the image model to spell the headline.
- Use subject/technical imagery in v1. There is no portrait input today. Update the Packaging prompt and deterministic mock to produce concepts suitable for this capability; do not imply generated people depict the creator. Older concepts mentioning a presenter can be edited before rendering.
- Produce a 1280×720 sRGB JPEG, conservatively below 2 MB, and retain the background separately. These are deliberate v1 output choices, not a claim about YouTube's maximum. Current official guidance recommends higher-resolution thumbnails and permits larger desktop/API uploads; this size keeps the existing generator contract and reaches YouTube's 720p A/B threshold. [Custom thumbnails](https://support.google.com/youtube/answer/72431?hl=en), [A/B testing](https://support.google.com/youtube/answer/16391400?hl=en), [thumbnail upload API](https://developers.google.com/youtube/v3/docs/thumbnails/set).
- Validate image decoding, dimensions, MIME type, file size, and headline bounds before marking a revision ready. Visual truth, composition, and small-size readability still require creator review.
- Background cache identity includes provider/model, assembled prompt, size, quality, and an explicit generation revision. Composition identity includes background hash, exact headline, brand/font, template identity, output dimensions, and encoder settings. A deliberate regeneration increments the generation revision; a retry reuses a verified successful background. Headline edits never regenerate the background.
- Write unique partial files and atomically promote verified outputs. Preserve all prior revisions. Record usage immediately after successful provider responses even if composition later fails. Do not schedule automatic creative retries or silently switch providers.

## Persistence and approval

Add optional `Project.thumbnails` state with a current packaging version/hash, A/B slot drafts, immutable successful revisions, and a selected revision reference or null. Each revision records concept ID, headline, direction, background path/hash, composed path/hash, pixel inputs, provider/model, timestamps, and job ID. Persist metadata in the existing SQLite project document and mirror versioned manifests under `packaging/thumbnails/`; files are artifacts, not a second source of truth. Existing projects normalize to empty thumbnail state.

Use `packaging/thumbnails/p<version>/<A|B>/r<revision>/` for managed artifacts. Reuse existing project locking, operation records, cancellation, safe paths, and recovery. Each completed slot is saved before starting the next; an interrupted revision is retryable and cannot be selected. No new database table or general job scheduler is necessary.

Keep the Packaging agent's strict `VideoPackaging` schema at 1.0.0: generation bookkeeping belongs to the runtime. Specialize `publishApproval` as an extension of `Approval` with an optional immutable thumbnail descriptor: packaging version/hash, slot, revision, path, and output hash. Preserve the existing document hash semantics. Legacy approvals without a descriptor mean no custom thumbnail and remain valid only when no thumbnail is selected.

At approval and immediately before upload, verify the selected revision belongs to the current package and its bytes match the stored hash. Upload exactly the approved descriptor's path. Never substitute a newer revision or silently omit a missing selected file.

- Selecting, clearing, or explicitly replacing the selected revision clears publication approval. Regenerating packaging also clears the selection and approval.
- Editing an unselected variant or making a new unselected revision does not change the pinned upload or invalidate approval. If a selected slot gains a newer revision, show which revision remains selected and require an explicit **Use updated version** action to replace it.
- Rough-cut and production-plan approvals are unaffected by thumbnail edits. Existing downstream invalidation still governs packaging after a video revision.
- Published records preserve the selected descriptor. Inspect the pinned uploader's thumbnail failure behavior: if the video was created but thumbnail application failed, retain any reported video ID, surface the incomplete thumbnail handoff, and never automatically re-upload the video. Validate this with a CLI stub before enabling thumbnail upload.
- Extra uploader flags must not override the approved thumbnail path, including when “No custom thumbnail” was approved. Reject conflicting `-thumbnail` / `-thumbnail=…` extras before invocation while retaining OAuth flags.

## Thin implementation surface

| Area                                                                                         | Proposed change                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/orchestrator/src/thumbnails.ts` (new)                                              | Thumbnail schema, prompt assembly, render/cache/export helpers; no production-plan changes.                                                            |
| `model.ts`, `store.ts`, `studio.ts`                                                          | Optional state/defaults, domain methods, partial success persistence, usage, approval descriptor, publish preflight.                                   |
| `packages/remotion-engine/src/index.ts` and `templates/remotion/`                            | `renderThumbnail()` wrapper and one separate still composition. Hash its actual template dependencies without altering existing B-roll cache behavior. |
| `packages/agents/src/packaging.ts`                                                           | Thumbnail-only prompt/mock adjustment for subject imagery and concise contrasting concepts; no extra model call.                                       |
| `ipc.ts`, `cli.ts`                                                                           | Thin dispatch to the same domain methods.                                                                                                              |
| `Models.swift`, `StudioModel.swift`, `ReviewView.swift`, new `ThumbnailComparisonView.swift` | Codable thumbnail state, actions, compact cards, comparison/edit sheet, native preview/export, published read-only state.                              |
| `youtube.ts`                                                                                 | Use its existing thumbnail argument; handle/confine thumbnail-specific completion reporting as needed.                                                 |

Proposed domain operations: `thumbnails.get`, `thumbnails.render` (missing/current slots), `thumbnails.update` (save draft), `thumbnails.regenerate` (one slot), `thumbnails.select` (exact revision or null), and `thumbnails.export` (current pair). Rendering resumes missing work; regeneration deliberately requests a new background. IPC mutations carry the expected packaging version and slot revision so a stale sheet cannot overwrite newer work. Suggested CLI family: `wts thumbnails <project>` with `edit`, `regenerate`, `select`, and `export` subcommands.

## Delivery sequence and acceptance

1. **Render two real files.** Add the optional state and renderer using MockImageProvider, then reuse the existing live providers. Prove exact headline composition, 16:9 output, decoding/size limits, cache reuse, and one-slot failure/cancellation recovery in a disposable library.
2. **Make them reviewable.** Add packaging cards and the comparison/edit sheet. Verify actual native image loading, full-size preview, small-size readability, editing A without changing B, history selection, keyboard navigation, export, and restore after app restart. Check the minimum 1040×720 app window as well as the default size.
3. **Attach the approved selection.** Extend approval/publish checks and CLI/IPC coverage. Prove exact `-thumbnail` arguments with a fake uploader, rejected tampering, no-selection compatibility, packaging-version invalidation, conflicting extra-argument rejection, and video-created/thumbnail-failed behavior.

Run `bun run check`, format checks for touched files, `swift build --package-path apps/macos -c release`, and a focused real thumbnail-render integration test. Native UI proof and a disposable-library render are separate from static/unit checks. Live provider quality and actual YouTube application remain distinct checks; this planning work makes neither claim.

Done means a creator can generate A/B, compare them at feed size, fix a headline without buying another generation, export both exact files, select a revision, reopen the app with it retained, and pass that exact approved image to the uploader without rebuilding the video.

## Scope held for later

Live experiment creation, results/CTR ingestion, winner selection, scheduled thumbnail swaps, title experiments, third/fourth active variants, face extraction or portrait identity, image editing, background removal, imported custom artwork, and a general layout editor.

For the manual handoff, link to YouTube Studio's thumbnail-only A/B workflow. YouTube currently supports up to three alternatives, requires advanced-feature eligibility, and does not run these tests on private videos. Preserve the app's private upload behavior; the creator handles eligibility and visibility in Studio. [YouTube A/B testing](https://support.google.com/youtube/answer/16391400?hl=en).
