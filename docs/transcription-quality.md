# Transcription quality

Choose **GPT Transcribe + review** in Settings for new recordings, or **Transcribe & Review** on the Transcript tab to upgrade an existing recording. The latter uses OpenAI and is billed to the configured API account. It works while production is idle. Each recording is saved as it completes; failures retain earlier completed recordings and paid provider evidence.

The pipeline:

1. Silero VAD finds speech and checks clipping. Every second remains covered; speech detection chooses chunk seams, never discards audio.
2. `gpt-transcribe` recognizes verbatim speech in roughly 45-second chunks with technical keywords from the approved script. Repeats and spoken mistakes stay in the source transcript.
3. WhisperX aligns recognized words to the actual audio on this Mac. Unalignable/interpolated words cannot provide cut or caption timings.
4. Independent `whisper-1` recognition of every chunk detects disagreements, including fluent mistakes a text reviewer may miss. It receives audio alone.
5. A structured LLM pass (default `gpt-5.4`, configurable with `WTS_TRANSCRIPT_REVIEW_MODEL`) audits wording, omissions, repetition, incomplete speech and timing. Script text is context, never ground truth. Findings must reference existing segment IDs.
6. Flagged passages receive a focused independent audio recheck and alignment. Reliable results become proposed replacements. Agreement can dismiss an LLM wording suspicion; acoustic failures and recognizer disagreements remain for listening review. No lexical correction is automatically accepted.
7. Listen in **Review passages**. Keep the current wording, accept the audio recheck, or edit the wording and align it again. Playback stops after the passage. Decisions reject stale transcript hashes and are recorded with before/after hashes.

Repeated consecutive sentences are collapsed separately for editing, preferring the final complete take. The verbatim source, including stumbles, stays in History. The existing conservative exclusions for intentional script repetition, short beats, changed numbers and negation remain.

## Revision behavior

Original imports, model hypotheses, accepted corrections and review decisions are retained. JSON artifacts live under `transcripts/`, `transcripts/evidence/` and `transcripts/reviews/`; SQLite is authoritative. Reports bind to exact transcript hashes. History shows original imports and subsequent versions.

Reviewing a recording does not change an existing plan, approval, cut or captions. Plans and all derived consumers resolve their original transcript set by `transcriptHash`. Generate **New Storyboard from Transcript** to use the latest reviewed words and timings. Pending issues block new planning and A-roll drafting. A successful new storyboard invalidates downstream approvals; a failed generation keeps the previous plan and approvals.

Keeping a passage is a creator decision, not a claim that its timings passed acoustic checks. Segments without reliable word timing remain in the transcript; existing cut/caption logic skips unsupported word-level operations.

## Local dependencies

`bun run transcription:setup` installs pinned WhisperX/Silero dependencies into a managed Python 3.12 environment using `uv`. The first GPT review runs setup when needed and downloads alignment weights. Install `uv` and FFmpeg first. No Python packages are installed globally.

The acoustic worker disables ONNX Runtime telemetry before importing ML libraries. This avoids an observed macOS telemetry-thread crash during native shutdown; processing failures still stop the job and report their termination signal.

Overrides: `WTS_ALIGNMENT_ENV`, `WTS_ALIGNMENT_PYTHON_PATH`, `WTS_TRANSCRIPT_REVIEW_MODEL`. Local whisper.cpp remains available using `WTS_WHISPER_MODEL`. New cloud transcription uses `gpt-transcribe`; the Director model selection does not change the transcription or review models.

## Benchmark against real recordings

The benchmark reads the project database without changing it. It extracts one reproducible 32-second sample per recording, prioritizing a retake where available, and hashes the audio. Use a private directory outside the repository for these media artifacts.

```sh
bun run transcription:benchmark prepare --project <project-id> --directory <benchmark-folder>
bun run transcription:benchmark run --candidate whisper-small --directory <benchmark-folder>
bun run transcription:benchmark run --candidate whisper-large-v3-turbo --directory <benchmark-folder>
bun run transcription:benchmark run --candidate gpt-transcribe --directory <benchmark-folder>
```

Local candidates download canonical whisper.cpp weights on first use. Candidates are saved per sample, so subsequent runs resume completed work. Cloud evidence is checkpointed before subsequent processing. A pipeline identity prevents reuse of older cloud reviews; prior candidates are archived.

Listen to each `sample-N.wav`, then fill in its `reference-drafts/sample-N.json`:

- `text`: every word actually spoken, including repeats and false starts.
- `confirmedBy` and `confirmedAt`: the human reviewer and ISO timestamp.
- `words`: optional verified word boundaries, relative to the sample, or `null` if timing was not checked.
- `expectedDiscarded`: verified earlier-take intervals, or `null` if take selection was not checked. An empty array means no take should be removed.

Do not paste the script or a model output and call it verified. Certify the edited reference and evaluate:

```sh
bun run transcription:benchmark certify --reference <reference.json> --directory <benchmark-folder>
bun run transcription:benchmark evaluate --directory <benchmark-folder>
```

Reports separate word error rate (substitutions/deletions/insertions), median/p95 boundary error, and missed/incorrect take exclusions. Unchecked dimensions remain `null`. Agreement between models is not an accuracy score. Reference audio hashes and immutable reference versions prevent accidental comparison against changed samples. This benchmark supports calibration; it does not establish a universal "near perfect" guarantee.

## CLI review

```sh
bun run wts transcript review <project> --transcriber openai --recording <recording-id>
bun run wts transcript decide <project> --file <decision.json>
bun run wts transcript correct <project> --file <correction.json>
bun run wts plan <project> --from-reviewed-transcripts
```

A decision contains `reviewId`, `issueId`, `expectedHash` and `action` (`accept` or `keep`). A correction replaces `action` with the creator's exact `text`. The corresponding IPC methods are `transcript.review`, `transcript.decide`, `transcript.correct` and `transcript.history`; `plan.generate` accepts `fromReviewedTranscripts`.
