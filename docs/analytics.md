# Channel analytics and the next topic

Open **Channel** above Productions. The objective is **business leads and authority**. Next Topics holds editable briefs; Video Evidence holds dated YouTube reports; Outcomes holds creator-recorded conversations, opportunities, customers, authority signals and the editorial review queue.

## Start with Studio CSV or a read-only connection

**Import Studio CSV** accepts UTF-8 content tables exported from YouTube Studio Advanced mode. Select a report, enter the channel ID/name, inclusive date interval and Studio filters, then inspect the preview. The importer needs one row per video and an 11-character video ID. It recognizes common English headers and provides explicit mappings for other headers. Numbers use English decimal/thousands notation; watch time in a recognized `(hours)` column is converted to minutes. Custom watch-time headers must contain minutes. Quoted cells, BOMs, durations and percentages are supported. Totals are skipped, duplicate video rows rejected, and overlapping intervals remain separate. Empty cells stay missing; zero stays zero. A 500-row export may be truncated.

Confirm identity and the report interval before importing. Confirm completed coverage only when Studio shows data through the report's final date. In Video Evidence, confirm public availability and long-form/Short/live format. Importing an arbitrary calendar interval does not turn it into a first-28-days report. Visibility and format from a CSV are initially unknown.

**Connect YouTube** uses a Google Desktop OAuth client JSON. Enable YouTube Data API v3, YouTube Analytics API and YouTube Reporting API in its Cloud project. Use a separate project from the uploader for independent grants. Sign-in requests only `youtube.readonly` and `yt-analytics.readonly`, opens the system browser with PKCE, and returns to a temporary loopback listener. Confirm the returned channel name/ID. Client and refresh credentials live in macOS Keychain, scoped to this library; the uploader's credentials are untouched.

Connection setup discovers or creates the app's reach reporting job. Reach can take up to 48 hours and offers limited historical backfill. Basic metrics remain usable while reach is unavailable. Refresh obtains the latest 50 upload entries; **Load 50 older videos** extends the catalog to at most 500. Coverage is explicit, and private uploads, unknown formats, Shorts and live streams do not enter long-form topic evidence. Channel open refreshes once per app session when the last sync is more than 24 hours old. Manual Refresh remains available. Sync has its own cancellation and channel lock and does not block project work.

**Explore sample channel** uses fictional records and local mock proposals. It is separate from your channel and cannot create real productions or invoke a paid provider.

## Choose and test a brief

Set the target buyer, problem, available proof, offer and next step in **Strategy**. Generation returns up to five structured topic briefs with a rationale, counterevidence and testable hypothesis. Mock generation uses the strategy; it does not pretend to have learned a performance pattern. The configured remote provider requires explicit consent in Strategy. Outcome notes and anonymous opportunity IDs are never sent in the outcome summary. Sharing outcome stages, buyer fit and attribution requires a separate opt-in.

Automated use of YouTube/Studio evidence remains disabled until an actual API approval reference is recorded in Strategy. A read scope alone is not evidence of approval for derived analysis. The default still supports direct metrics, creator lessons and strategy-led topic generation. Do not enter a placeholder approval reference to bypass this boundary.

Eligible analysis uses one complete report per public long-form video, prefers YouTube over overlapping CSV imports, and selects a common first-28-day window (7 or 90 days when no 28-day window exists). Dates use Pacific reporting days, with a potentially partial release day. Fewer than five comparable videos forces an **Explore** label. Supporting evidence is a reason to test an idea, not a forecast of leads or proof of causality. Raw source percentages are shown as supplied; the app does not sum percentages or infer CTR from views/impressions.

Save or dismiss ideas without changing creator preferences. Generate again to create a new batch; saved, dismissed and production decisions survive. Expand the evidence section to see source intervals and uncertainty. Edits create a new brief version. **Create project** lets you edit the handoff, creates exactly one `IDEA` project, snapshots the selected brief and hypothesis, and opens Pre-Production. Research remains an explicit action; all existing production approvals remain in force.

Record business outcomes using an anonymous opportunity ID. Reuse the ID when a conversation progresses to opportunity or customer. Qualified business counts and the model summary deduplicate that progression. Attribute it explicitly as prospect-named-video, creator-associated or channel-level/uncertain; an association is not a causal claim.

Reviews become due at 7, 28 and 90 reporting days only when an exact complete basic report exists. The upload-completion timestamp never starts a public countdown. Review the original hypothesis, audience evidence and local outcomes, record the lesson, and choose follow-up/change-angle/explore-adjacent/inconclusive. “No outcomes” requires an explicit check. A saved review can create one linked follow-up draft. Waiting reviews can be snoozed.

## CLI and persistence

Use a disposable `WTS_HOME` when experimenting. `bun run wts --help` lists the command groups. Examples:

```sh
WTS_HOME=/tmp/my-channel-pilot bun run wts analytics sample
WTS_HOME=/tmp/my-channel-pilot bun run wts analytics status
bun run wts analytics connect /path/to/desktop-client.json
bun run wts analytics sync --channel UC_CHANNEL_ID
bun run wts analytics import /path/to/report.csv --file /path/to/report-options.json
# Commit the preview only after inspecting the matching channel/interval:
bun run wts analytics import /path/to/report.csv --file /path/to/report-options.json --yes --complete
bun run wts strategy save --channel UC_CHANNEL_ID --file strategy.json
bun run wts topics generate --channel UC_CHANNEL_ID --provider mock
```

Report options JSON contains `channelId`, `channelTitle`, `start`, `end`, `filters` and optional `mapping` (`videoId`, `title`, `views`, `watchMinutes`, `averageViewDuration`, `averageViewPercentage`, `subscribersGained`, `subscribersLost`, `impressions`, `ctr`). `strategy save`, `outcomes save` and `reviews save` read their typed record from `--file`. Topic updates/decisions/project creation and review follow-up read their named RPC parameters. `analytics call <method> --file params.json` exposes the same validated domain operations as IPC; include `channelId` in that file.

`analytics.snapshot` returns strategy, videos, reports, topics, outcomes and queue together. Connection uses configure/begin/finish/confirm/cancel/disconnect; import uses preview/commit. See `analytics/service.ts`'s dispatch switch and `analytics/model.ts` for the exact contracts.

SQLite schema version 2 adds channel-scoped records and PID/token locks transactionally. Existing project records remain compatible. Raw CSV artifacts carry expiry metadata under `analytics/<channelId>/`; accepted topic briefs live in project `research/`. Source evidence expires after 30 days without refresh, with cleanup on the next analytics operation. Cached evidence is not claimed to be current. Disconnect/delete local analytics removes connection tokens and source evidence, marks topic evidence unavailable and removes dependent brief artifacts while retaining creator-authored strategy, productions, business records and review lessons. Disconnect is local; revoke the grant separately in your Google Account if desired. No analytics daemon runs while the app is closed.

## Validation and external boundaries

`tests/analytics.test.ts` exercises import/migration, private/public dates, review coverage, outcome privacy, channel isolation, locks, topic provenance/idempotency, expiry, OAuth state/PKCE/refresh/cancellation, pagination and partial sync. The IPC test exercises the native contract. `bun run check` and `swift build --package-path apps/macos -c release` are the local gates. Native testing uses a separately identified development bundle and a disposable library; building the release executable does not install it into `/Applications`.

No real channel grant, paid topic-model request or representative creator Studio export was used for implementation validation. Live provider acceptance, channel-specific report availability, source CTR units and the required API approval remain separate pilot checks. The adapter follows these primary references:

- [Analytics channel report combinations](https://developers.google.com/youtube/analytics/channel_reports)
- [Reporting reach reports](https://developers.google.com/youtube/reporting/v1/reports/channel_reports#reach-reports) and [metric definitions](https://developers.google.com/youtube/reporting/v1/reports/metrics#video_thumbnail_impressions_ctr)
- [Bulk report lifecycle](https://developers.google.com/youtube/reporting/v1/reports)
- [Desktop OAuth](https://developers.google.com/youtube/reporting/guides/authorization/installed-apps)
- [Public timestamp semantics](https://developers.google.com/youtube/v3/docs/videos#snippet.publishedAt)
- [YouTube derived-metrics policy](https://developers.google.com/youtube/terms/derived-metrics-policy)

Local acceptance on 2026-09-17/18: `bun run check` passed 164 tests; release Swift compilation passed (existing warnings in unrelated native files remain); the Keychain helper typechecked. After review, `swift test --package-path apps/macos -c release` also passed three native payload tests. A disposable native bundle verified sample isolation, saved-topic persistence, video-table decoding, a completed review producing a linked follow-up, CSV preview/duplicate import, and the edited brief → single IDEA project → Pre-Production handoff. Restart preserved records, and an explicit subsequent mock Research call succeeded. No app was installed into `/Applications` and no real channel or production library was changed. See [review findings and resolutions](analytics-review.md).
