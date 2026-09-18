# Analytics feedback loop: what to make next

Status: approved plan, implemented locally on `codex/analytics-feedback-loop` in the separate `yt-studio-analytics` worktree. See [the implemented workflow](../analytics.md). Live channel authorization and API-derived-analysis approval remain external pilot gates.

Implementation details: topic evidence expands inline within native cards; the editable handoff uses a dedicated sheet. Video Evidence uses a native table/detail split and a retention chart. Settings links to Channel management. `analytics.snapshot` consolidates the proposed list/get RPCs, OAuth has explicit begin/finish/confirm/cancel operations, and evidence selection lives in `analytics/service.ts`. Initial catalog scope is the latest 50 upload entries, expandable in batches to 500, rather than promising 50 eligible videos within a date range.

## Product decision

Build a channel-level **Next Topics** workspace that turns published-video evidence and creator-recorded business outcomes into a small, reviewable editorial shortlist. The user chose **business leads and authority** as the primary objective.

The core decision is: “What should I explain next to attract the right buyer and demonstrate useful expertise?” A lower-reach video that prompts qualified conversations can deserve a follow-up. High views alone do not establish buyer relevance, authority, or commercial value.

The loop is:

`Channel strategy → published videos + business outcomes → evidence review → topic shortlist → creator selects a brief → existing production workflow → publication → 7/28/90-day review`

Success means the creator can select a defensible next topic in one short review session, then trace the resulting video's outcome back to that original hypothesis. The feature recommends; the creator chooses.

## Current foundations and necessary changes

Verified against the current checkout:

| Existing foundation                                                                                                                                        | Consequence for this feature                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/macos/Sources/YTAIStudio/App.swift` is a project-first `NavigationSplitView`, with native grouped surfaces, serif headings and a warm accent.        | Add a channel workspace above Productions. Keep the existing visual language and project navigation.                                                          |
| `StudioModel.swift` has a project selection, a global busy flag and project-scoped operations.                                                             | Add an explicit workspace route and independently cancellable analytics activity. Refreshing analytics must not block recording, editing or rendering.        |
| `Project.publication` stores `videoId`, URL and a locally generated `publishedAt`. `Studio.publish` records it after uploading, including private uploads. | Reuse the ID for matching, but obtain visibility and publication timing from YouTube. Preserve the upload record as history.                                  |
| `CreatorProfile` contains subjects, format, duration and explicit preferences; each project snapshots it.                                                  | Introduce a separately versioned channel strategy: buyer, problems, expertise, offer and CTA. Snapshot it when a topic becomes a project.                     |
| `AnalyticsObservation` already exists in `packages/agents/src/index.ts`, including `causalClaim: false`. It has no executable adapter or persistence flow. | Extend this contract with typed metrics, source references, coverage and nullable values. Keep observations separate from hypotheses and creator preferences. |
| Research currently consumes the project description and writes from model knowledge without browsing.                                                      | Pass the selected editorial brief as structured context. Analytics is audience evidence, not proof of technical claims or current market trends.              |
| `studio.sqlite` is authoritative. Store initialization currently sets `user_version=1` unconditionally.                                                    | Introduce ordered, transactional migrations before adding channel tables; preserve existing projects.                                                         |

## Scope of the first release

One connected channel per library, with channel-scoped storage from the start. Focus on public, long-form technical videos. Start with the latest 50 eligible videos from the last 12 months; disclose this coverage and support an explicit “Load older videos” action. Import videos produced outside this app without creating fake production projects.

Include:

- Read-only channel connection and a guided YouTube Studio CSV import fallback.
- A concise evidence library with comparable video windows and visible data coverage.
- Editable channel strategy and lightweight, creator-recorded business outcomes.
- Three to five topic briefs per generation, plus saved and dismissed ideas.
- Evidence references, counterevidence and a proposed business hypothesis on every brief.
- One explicit action to create a project from an edited brief.
- A review queue that closes the loop after that video's release.

Defer CRM integrations, website tracking, revenue attribution, competitor scraping, comment harvesting, title/thumbnail experiments, multi-channel management, real-time analytics and autonomous changes to published videos. Retention-to-scene diagnosis can follow the first release; aggregate retention is enough for topic selection.

## Native UI and interaction

### Navigation

Add **Channel** above the existing Productions list. Its detail view has three tabs: **Next Topics**, **Video Evidence**, **Outcomes**. Connection status and Refresh sit in the channel toolbar; strategy and connection management live in Settings. New Project remains available for manual ideas.

Published project Overviews gain an **Audience & outcomes** card with “View evidence” and “Record outcome.” This avoids adding another tab to the already crowded production tab row. Unlinked projects offer “Link YouTube video”; matching uses exact video IDs and channel ownership, never title similarity.

### First use

1. Show “Turn your channel's results into your next brief,” with **Connect YouTube**, **Import Studio report**, and **Explore sample data**. Sample mode is visibly labeled and isolated from real data.
2. Connection opens the system browser. Confirm the returned channel name and ID before its first sync; a Google account can represent different channel identities.
3. Strategy asks for four short inputs: target buyer, expensive problem, expertise/proof available, and desired next step or offer. Seed subject suggestions from the existing creator profile, but do not assume the user sells consulting. “Not decided” remains valid.
4. Display initial-sync progress and partial results. A reach-report wait must not block the rest of the workspace.

### Next Topics: primary screen

At the top: the active strategy in one sentence, data-through date, and **Generate topics**. The initial view should explain a decision, not lead with a wall of channel KPIs.

Show three to five compact topic rows. Each contains a working title, target buyer/problem, a one-line rationale, intended CTA, and an evidence label: **Supported**, **Directional**, or **Explore**. These are product judgments with visible reasons, not probabilities or YouTube metrics.

Selecting a row opens a right-hand inspector:

- **The brief:** thesis, viewer promise, intended buyer, concrete demonstration and proposed CTA.
- **Why consider it:** cited video observations, separately labeled creator outcomes, and the reasoning connecting them to the topic.
- **What could weaken it:** missing data, a contradictory example, overlap with a recent video, or an uncertain buyer assumption.
- **Test next:** one falsifiable hypothesis, an agreed review date, and what the creator will look for.

Actions: **Create project**, **Save for later**, **Dismiss**. Dismissal offers optional reasons such as Wrong buyer, Already covered, Insufficient proof, and Not now. These steer future shortlists without silently changing creator preferences. Regenerating preserves saved items, decisions and existing projects; a new batch records its own evidence version.

**Create project** opens the existing New Project sheet extended with the editable brief. Confirming creates an `IDEA` project, stores the selected brief and evidence references, and opens Pre-Production. It does not start a paid Research call. Double-clicks or IPC retries return the same project. The topic then reads **In production → Open project**.

### Video Evidence

A native table lists title, public date, window, views, average view duration/percentage and data status. Optional columns expose impressions/CTR when available. Default comparison is the first 28 reporting days for mature, comparable long-form videos; first 7 days is an explicit early view. Lifetime totals are labeled separately.

Clicking a video shows exact metric values, report dates, traffic/search details when available, title/thumbnail metadata, any linked production and creator outcomes. Distinguish **YouTube data**, **Creator record**, and **Studio interpretation** using text, not color alone. Open in YouTube Studio is available as a contextual action.

Before comparing, show the included videos and excluded reasons. Allow corrections to topic/format tags and explicit exclusion of atypical campaigns. Topic tags are creator/Studio labels, never presented as YouTube categories. Avoid a single unexplained “performance score.”

### Outcomes

The review queue shows **Ready for review**, **Waiting for data**, and **Reviewed**. The 7-day check covers initial audience response, 28 days covers the editorial hypothesis, and 90 days revisits longer sales cycles. Reviews become due only when their measurement window is available, not merely when the wall clock reaches a date. Dismiss/snooze is available.

“Record outcome” is a small sheet: outcome type, date, buyer fit, video or topic association, attribution basis, and a short optional note. Types: qualified conversation, opportunity, customer, and authority signal (for example, a relevant invitation or a video used in a sales conversation). Store an anonymous local outcome ID; names, email addresses and deal values are unnecessary for v1.

Attribution is explicit: **Video named by prospect**, **Creator-associated**, or **Channel-level / uncertain**. An opportunity can progress to customer without becoming a second independent lead. Separate outcomes may belong to one anonymous opportunity; counts deduplicate it. Unrecorded outcomes display **Not recorded**, not zero. “No outcomes recorded after review” is a distinct explicit observation.

At review, show the original brief/hypothesis alongside audience evidence and these outcomes. The creator can choose **Follow up**, **Change angle**, **Explore adjacent**, or **Inconclusive**. Follow up creates a topic draft with links back to the review; it does not automatically begin production.

### Visual and accessibility requirements

Use existing `studioCard`, `studioHeading`, `PrimaryActionButtonStyle`, `QuietButtonStyle` and color tokens. Keep the warm accent for the primary decision. Use native tables and Swift Charts for time series; show units, dates and accessible summaries. At the app's minimum width, switch the inspector to a detail sheet if needed. Support keyboard selection, VoiceOver, selectable evidence text and focus restoration after sheets. Status must remain understandable without color.

### Required states

| State                                     | UI behavior                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| No connection / no reports                | Offer connect, import or labeled sample data; manual project creation works.                                                                      |
| Strategy incomplete                       | Allow evidence review; request missing buyer/offer details when generating a business brief. Exploration remains possible with assumptions shown. |
| Few videos / few views                    | Show an exploratory shortlist grounded in expertise and buyer questions. Do not manufacture performance conclusions.                              |
| Private, scheduled or unlisted upload     | Show its actual visibility; no public-release review countdown.                                                                                   |
| Reach report pending                      | Explain that impressions/CTR are waiting; show the rest of the evidence.                                                                          |
| Offline or stale sync                     | Keep permitted cached data readable, with timestamp and retry; do not claim it is current.                                                        |
| Partial, suppressed or missing metric     | Show the specific status and an em dash, never zero-fill.                                                                                         |
| Wrong channel, revoked grant, quota limit | Offer channel reconnect or a retry time without breaking project work.                                                                            |
| Generation fails or is cancelled          | Preserve the previous shortlist and saved work; no half-created topic batch.                                                                      |
| New data after topic selection            | Show “New evidence available.” Preserve the selected brief; updating it is an explicit new revision.                                              |

## Data acquisition and its real limits

Use a dedicated local `youtube-analytics` adapter; publishing continues through the current `youtubeuploader` adapter. Do not parse its token cache or presume upload authorization includes analytics access.

| Data                                                                       | Proposed source                                                                 | Handling                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel identity, uploads and video metadata                               | YouTube Data API; own uploads playlist with pagination and batched video lookup | Verify ownership; retain public date, visibility, duration and metadata fetch time. Unknown content type stays excluded until classified.                                     |
| Views, watch time, average duration/percentage and subscribers gained/lost | YouTube Analytics targeted queries                                              | Fetch allowed report combinations separately; retain exact windows and returned coverage.                                                                                     |
| Traffic sources and search terms                                           | Analytics traffic reports                                                       | Search terms describe discovery of this channel's videos, not global keyword demand. Absence can mean suppression or limited report coverage.                                 |
| Audience retention                                                         | Analytics single-video retention report                                         | Fetch on demand; it is not a unique-viewer survival curve and may reflect rewatches.                                                                                          |
| Thumbnail impressions and CTR                                              | Reporting API reach report, or a compatible Studio export                       | Discover supported report types. The documented basic type is `channel_reach_basic_a1`; it is a separate bulk-report job, not a metric added to the ordinary Analytics query. |
| Business outcomes and proof of expertise                                   | Local creator records                                                           | Keep their attribution and provenance separate from YouTube measurements.                                                                                                     |

YouTube's [Analytics report definitions](https://developers.google.com/youtube/analytics/channel_reports) specify compatible dimensions and metrics; basic video, traffic, and retention queries require different shapes. Verify those exact query shapes with a real authorized channel during implementation. The [reach report reference](https://developers.google.com/youtube/reporting/v1/reports/channel_reports#reach-reports) documents daily impressions and CTR.

Reporting is asynchronous: new jobs can take up to 48 hours, and their historical backfill covers roughly the preceding 30 days. Download windows are limited, and newer backfills replace earlier reports. Persist report IDs and coverage; recover missed periods where available and mark unrecoverable gaps. Never promise lifetime CTR on first connection. See the [bulk-report lifecycle](https://developers.google.com/youtube/reporting/v1/reports).

### OAuth and sync

- Use desktop OAuth with PKCE, state validation and the system browser. Scopes: `youtube.readonly` and `yt-analytics.readonly`; monetary access is unnecessary. Keep refresh credentials in Keychain, keyed by the analytics client and account/channel context. Share a credential abstraction between app and CLI; never place tokens in project JSON, SQLite, logs or artifacts.
- The desktop flow needs a short-lived, loopback-only callback listener. Document this narrow exception to the repository's “no HTTP server” architecture; it is not a backend or app API. Shut it down on completion, timeout or cancellation. See [desktop authorization](https://developers.google.com/youtube/reporting/guides/authorization/installed-apps).
- Use a separate Google OAuth project from the uploader if independent revocation is required. The documented grant revocation can invalidate other scopes/clients in the same Google project; a different Keychain name alone does not isolate it.
- Initial sync imports catalog plus bounded historical metric windows. Subsequent sync runs on channel open if older than 24 hours, or on Refresh, with bounded concurrency and backoff. No daemon is promised while the app is closed.
- Requery a rolling recent window for corrections and refresh due 7/28/90-day reviews. Track freshness per report family; one failed query must not make all families look current. Request cancellation propagates to network work.
- Reporting jobs are created only as part of explicit connection setup. Discover/reuse the app's own job rather than creating duplicates or deleting another client's jobs.

### CSV fallback

Support a documented English-language Studio content-table export initially, with an explicit header-mapping preview for variants. Accept UTF-8/BOM, quoted cells and known duration/percentage units. Require a channel label/ID, date interval, filters and row grain; never infer “first 28 days” from an arbitrary export range. Require video IDs for automatic joining. Reject totals rows as videos, and do not add overlapping aggregate exports together.

Hash imports for idempotency; show matched/unmatched videos, duplicate coverage and missing columns before committing. Require user confirmation for channel identity when it cannot be independently verified. Keep API and imported observations as distinct sources, with explicit active coverage. A 500-row Studio export can be truncated; disclose completeness instead of treating it as the entire channel. See [Studio Advanced mode exports](https://support.google.com/youtube/answer/9717005?hl=en).

## Evidence and recommendation rules

### Measurement contract

Every observation records channel/video, metric name and unit, provider/report family, query or import reference, interval, timezone, fetched time, data-through date, and coverage state. Values are nullable. Distinguish observed zero, not yet available, unsupported, suppressed/omitted, failed and unknown.

Use verified public metadata to anchor comparisons. The app's existing `publication.publishedAt` is an upload-completion timestamp. YouTube's [`snippet.publishedAt`](https://developers.google.com/youtube/v3/docs/videos#snippet.publishedAt) has visibility-dependent semantics, so validate status and keep an explicit public-start provenance. If it cannot be established, allow a creator-confirmed date and label it.

First 7/28 reporting days means the public-release reporting date plus the following 6/27 dates, inclusive; the first date can be partial. Do not call it an exact 168/672-hour window. Analytics uses [Pacific reporting dates](https://developers.google.com/youtube/analytics/dimensions#time-periods), not the Mac's local timezone. Preserve the source boundaries for bulk reports and exports too; reconcile them before combining sources. A requested end date may exceed the [actual available data](https://developers.google.com/youtube/analytics/reference/reports/query#parameters).

Compare only the same format and observation window, with relevant length bands and visible topic/traffic context. Exclude private/test uploads and Shorts/livestreams from long-form comparisons; use supported content-type metadata or creator confirmation rather than a duration-only guess. With fewer than five comparable mature videos, label the pattern exploratory. This is a product heuristic, not statistical significance.

Use API-provided interval averages when possible. Never sum percentages or average daily CTRs unweighted. Bulk CTR aggregation, when enabled, uses impression weighting and source-verified units; average view duration/percentage must follow the documented denominator. Do not divide total views by thumbnail impressions to invent CTR. Keep such calculations behind the policy capability described below.

### What the system proposes

Business strategy determines eligibility and editorial ordering; YouTube evidence informs the proposed angle and uncertainty. Do not infer a viewer's job, purchase intent or company from aggregate analytics.

1. Start from creator-confirmed buyers, business problems, expertise/proof and current offer. A useful topic can be valuable even without a commercial CTA; label it as authority-building.
2. Assemble evidence from comparable published videos, creator-reviewed lessons and separately attributed business outcomes.
3. Propose a bounded mix: a follow-up on an established problem, an adjacent buyer question and an exploratory authority piece. Do not force all three when evidence is insufficient.
4. For each, provide a specific thesis, proof to show, audience promise, suggested format/duration, CTA, evidence IDs, counterevidence and a review hypothesis. Identify repeated coverage and explain the new angle.
5. Rank by explicit buyer/problem relevance and proof readiness, then by supporting evidence and production effort. Show the rationale; v1 has no opaque numerical authority/lead score or predicted lead count.

Example only: “Why your multi-region design still has one failure domain” could serve an engineering leader deciding whether to invest in resilience, demonstrate a failure test, and invite a relevant architecture discussion. A previous video named in a qualified conversation is commercial evidence; a high view count alone is not. The mockup uses fictional outcomes and metrics, not the user's channel.

The Topic agent receives a bounded, typed evidence packet and strategy, never raw credentials. It returns a Zod-validated proposal through the existing `AIProvider.generateStructured` contract, with deterministic mocks. Numeric claims are rendered from referenced observations rather than free-form model arithmetic. Reject unknown evidence IDs, mismatched channels/windows, fabricated outcomes and unsupported causal assertions. Free-text observations and imported cells are untrusted content.

Remote analysis is an explicit provider choice with a clear description of the aggregate channel data sent. Business notes stay local by default; send only approved anonymous summaries if enabled. Refresh does not trigger a paid generation. Record model, prompt/algorithm version, usage and input hashes.

### YouTube API policy dependency

Current [developer policy III.E.4 and III.L](https://developers.google.com/youtube/terms/developer-policies) restricts derived API data and describes an application/audit path for additional analytics permissions. The [additional policy](https://developers.google.com/youtube/terms/derived-metrics-policy) covers examples including custom scores and content categorization. **Implementation prerequisite:** verify the application's accepted use case covers API-fed categorization, comparisons, recommendations and any external model processing; do not assume a read scope grants those permissions. This is a documented dependency, not a finding that this app has approval.

Until resolved, support direct metrics, creator-authored lessons and editorial briefs from those lessons/strategy; keep automated API-derived analysis disabled. Manual CSV upload is not assumed to bypass applicable terms. Label Studio judgments separately from YouTube data.

Apply retention rules to raw reports, metadata and any evidence copied into proposals. Metadata needs refresh/deletion on its applicable schedule; retained authorized statistics require continuing authorization/resource checks. Provide Disconnect and Delete local analytics data, with deletion of dependent evidence and credentials. Preserve independently authored production material and business records; redact purged source data from linked briefs and mark references unavailable. An immutable decision history must not prevent required deletion. Final retention and offline-expiry behavior belong in the adapter contract before release.

## Architecture and persistence

Keep the local SwiftUI → private JSON-lines IPC → `Studio` → SQLite architecture. No production-plan schema bump is needed: editorial strategy precedes the production plan.

Proposed modules:

| Area                                                                                                    | Responsibility                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/orchestrator/src/analytics/model.ts`                                                          | Zod contracts for channel, observations, coverage, outcomes, reviews and topic briefs.                        |
| `analytics/youtube.ts`, `analytics/oauth.ts`, `analytics/csv.ts`                                        | Typed API transport, consent/credential lifecycle and bounded imports; inject transports for tests.           |
| `analytics/store.ts`, `analytics/service.ts`, `analytics/evidence.ts`                                   | Channel persistence, sync/recovery, evidence selection, due reviews and supported deterministic calculations. |
| `packages/agents/src/topics.ts`                                                                         | Structured topic proposals, evidence validation and deterministic mocks.                                      |
| `studio.ts`, `ipc.ts`, `cli.ts`                                                                         | Shared domain entry points; project creation from a selected brief; app/CLI parity.                           |
| `apps/macos/Sources/YTAIStudio/AnalyticsViews.swift`, `AnalyticsModels.swift`                           | Native channel workspace, inspector, importer, outcomes and review sheets.                                    |
| Existing `App.swift`, `StudioModel.swift`, `Models.swift`, `SettingsView.swift`, `WorkspaceViews.swift` | Routing, background progress, decoding, strategy/connection settings and project handoff.                     |

Persist channel connections (without tokens), strategy versions, video records, project-video links, sync runs/report manifests, observations, business outcomes, editorial reviews, topic batches and topic decisions in channel-scoped tables. All composite identities include `channelId`; transactions commit complete report replacements. Use a separate channel lock with the existing PID/token recovery discipline, not a fabricated project ID.

Store raw report artifacts under library-level `analytics/<channelId>/` using managed-path helpers, hashes and restrictive permissions. Artifact manifests carry expiry/deletion metadata. Keep proposal IDs, author decisions and evidence revisions reproducible for as long as source retention permits. Enforce uniqueness for video links and topic-to-project creation; a retry cannot create duplicate projects or double-count reports.

Add optional `topicOrigin` to `Project`: brief ID/version/hash, strategy version, hypothesis and review schedule. Store the accepted editable brief under project `research/`; only a pointer and small summary enter native snapshots. Legacy projects decode with no topic origin. API observations remain outside the project document to avoid bloated IPC and accidental retention copies.

Proposed public operations:

- IPC `analytics.connection.get/connect/disconnect`, `analytics.sync`, `analytics.import.preview/commit`, `analytics.videos.list/get`, `analytics.data.delete`.
- IPC `channel.strategy.get/save`, `outcomes.list/save`, `reviews.list/save`, `topics.list/generate/update/decide/createProject`.
- Matching CLI groups: `wts analytics`, `wts strategy`, `wts outcomes`, `wts topics`; use the same domain methods and validation.
- Typed progress events carry channel, run ID, stage and counts. Analytics requests do not attach the currently selected `projectId` automatically. Discard in-flight responses after switching/disconnecting channels.

Topic lifecycle: `proposed → saved | dismissed | in_production`; `in_production` points to the existing project state machine. Review lifecycle: `waiting → due → reviewed | snoozed`. Selecting a topic adds no new script/storyboard/rough-cut/publication approval gate and never edits those approvals.

## Delivery sequence and acceptance

| Milestone                      | Deliverable                                                                                                                                                 | Acceptance evidence                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Verify integration contract | Confirm one real channel's report capabilities, OAuth setup, supported exports, date semantics and analytics-policy entitlement. Capture redacted fixtures. | Document exact working queries and actual unavailable fields. Keep mock/native work progressing while external approval is pending.                                                                 |
| 1. Evidence foundation         | Migrations, channel records, Studio CSV preview/import, read-only connection/sync and video linking.                                                        | Import/sync twice without duplication; survive partial failure; correctly distinguish private uploads, missing data and channel mismatch. Show real report values in native UI.                     |
| 2. Business context            | Strategy, outcome ledger and 7/28/90-day review queue.                                                                                                      | Record and revise an anonymous opportunity without double-counting; show unknown attribution and unrecorded outcomes correctly.                                                                     |
| 3. Topic decision loop         | Shortlist, evidence inspector, save/dismiss, structured agent, editable brief → project → Research context.                                                 | Creator completes a full topic-to-IDEA flow; mock and configured-provider paths preserve evidence references and approvals. Automated API-fed analysis activates only after milestone 0 permits it. |
| 4. Close the loop and harden   | Refresh revisions, due reviews, follow-up drafts, CLI parity, recovery, cleanup and accessibility.                                                          | A selected topic's published video becomes reviewable and produces a cited follow-up; old projects, production jobs and publisher behavior remain intact.                                           |

Ship milestones 1–3 together as the smallest useful pilot. Milestone 4 completes the feedback cycle for general use. Reporting reach can become available progressively; it is never a prerequisite for choosing a topic.

Testing should cover:

- Migrations against existing libraries; legacy project decoding and profile snapshot preservation.
- OAuth cancellation, state mismatch, refresh, revocation, redaction and channel isolation using injected transports.
- Pagination, quota/retry handling, corrections/backfill replacement and sync cancellation without corrupting a completed snapshot.
- CSV BOM/quoted content, invalid units, totals rows, duplicate IDs, overlaps, truncation and wrong-channel imports.
- Pacific date boundaries/DST, public-versus-upload time, immature cohorts, missing versus zero and incomplete metric families.
- Evidence validation, no invented numbers/lead attribution, stable decisions after regeneration and idempotent project creation.
- Outcome stage progression, uncertain attribution, stale evidence and deletion across dependent artifacts.
- IPC decoding plus native keyboard/screen-reader flows; analytics refresh while production remains usable.

Run `bun run check`, formatting checks on changed files, and `swift build --package-path apps/macos -c release`. This feature does not justify rerendering the media integration suite unless production behavior changes. Separately prove live provider ingestion, persistence after restart and native interaction with the creator's authorized channel; tests alone do not establish those.

Pilot success: the creator can select a cited topic within roughly five minutes, each selected brief states buyer/problem/proof and a review hypothesis, and published follow-ups receive an explicit outcome review. Assess qualified conversations/opportunities over the agreed 90-day window and keep attribution coverage visible. Topic acceptance and view growth are secondary signals, not proof that the feature caused business results.

## Remaining product inputs

The objective is confirmed: business leads and authority. Actual buyer, offer, proof inventory and qualification criteria belong in first-run strategy, not hardcoded assumptions. Implementation also needs a real authorized channel and a representative Studio export. Neither is required to review this plan and its illustrative UI.
