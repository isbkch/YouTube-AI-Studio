# Why Redundancy Is Not High Availability

A 72-second, six-scene technical essay fixture. The script and all visual assets are authored for this repository. No downloaded footage, real person's likeness, private recordings or paid API calls are used.

`bun run demo` renders a labelled **synthetic A-roll placeholder** from the checked-in Remotion template. It generates each narration paragraph with macOS `say`, pads it to a 12-second interval, then combines it with the placeholder frame using FFmpeg. This is a still stand-in for talking-head footage, not a claim that a human presenter was recorded. It exercises the same video, audio and timing pipeline as a real import.

Included:

- `script.txt`: title and six narration paragraphs.
- `transcript.json`: segment timestamps in seconds, aligned to the six padded speech intervals.
- `production-plan.json`: normalized valid v1 plan, six scenes.
- `director-response.json`: the complete deterministic mock Director output.

The fixture recording ID is `demo-recording`. The runtime binds it to the newly imported recording ID. The example plan's transcript hash refers to the normalized example transcript; actual project plans refer to their actual transcript hashes.

Scenes: presenter, callout, shared-dependency architecture, presenter, recovery-path architecture, closing chapter/title. During the demo, a second plan version changes the callout; three graphics and five preview segments must be reused.

Generated outputs live in `.demo`, not Git. `.demo/demo-result.json` identifies the newest project, MP4 preview and Resolve export. Each project contains timeline JSON, FCPXML, OTIO, QA, plan/patch history, derived media and provenance stored in SQLite. Use `bun run macos:demo` to inspect them in the native app. Demo harness approvals are test actions; the resulting rough cut remains awaiting human approval.
