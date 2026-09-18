# DaVinci Resolve support

The MVP exports both FCPXML 1.8 and OTIO, plus the application-neutral timeline JSON. The **FCPXML is the primary finishing handoff**: it includes a conformed A-roll track, narration audio, connected full-frame graphics, scene markers, punch-in sizing and audio gain. It references local files with encoded file URLs. Move/back up the whole project; moving it later requires Resolve media relinking or a regenerated export.

The export uses 720p/30fps proxies for reliable rough-cut timing, including footage originally recorded at a fractional or variable frame rate. Original imported recordings remain available in the project for manual reconform and final grading. Automatic original-resolution reconform, grading, complex transitions, mixed source frame rates in final delivery, Fusion compositing and final delivery presets are outside this MVP.

## Manual import (works independently of external scripting)

1. Create or open the intended Resolve project.
2. Choose **File → Import → Timeline…** (Shift-Command-O on this installation).
3. Select the `.fcpxml` in the project's `renders` directory.
4. Keep source-clip import and sizing information enabled. The importer should report **1920×1080, 30 fps**.
5. Inspect V1 presenter clips, V2 generated graphics, A1 narration and scene timing.

Verified on the installed Resolve 21.1: the generated demo imported into the isolated **WTS MVP Export Verification** project, showed a **00:01:12:00** timeline, loaded all media, displayed the architecture animation over preserved A-roll, and showed narration waveforms. The project was saved. This was a manual import verification through Resolve's UI; the production adapter itself does not automate the UI.

## Scripting adapter

The installed vendor documentation confirms `ProjectManager.CreateProject`, `MediaPool.ImportTimelineFromFile` (AAF/EDL/XML/FCPXML/DRT/ADL/OTIO), timeline track inspection, and render APIs. Resolve 21.1 bundles a Python interpreter at `Contents/Applications/ResolvePython` with its scripting module available out of the box.

The trusted `bridge.py` supports four allowlisted actions:

- `probe`: connect and report product/version.
- `import`: create a uniquely named project, import a supplied generated timeline, save it and return track/duration information. It refuses to overwrite an existing named project.
- `render`: create a uniquely named project, import the FCPXML timeline, optionally apply a checked-in Fusion macro to every V1 clip, render with a validated preset and verify the produced file.
- `markers`: read-only read-back of review markers from the currently open Resolve project and timeline. It never creates, switches or saves projects. Clip markers are offset by their clip's timeline start; the studio normalizes timeline numbering (subtracting the timeline start frame) and maps each marker onto the plan scene its frame lands in.

```sh
bun run wts resolve probe
bun run wts resolve import /absolute/path/to/resolve-v2-HASH.fcpxml "My new Resolve project"
```

External scripting requires a running, fully loaded **Resolve Studio** instance with Preferences → System → General → External scripting set to **Local**; the free edition gates scripting (free 21.1+ ships no Python scripting at all). It is not enabled by this app. On this development machine the scripted path is verified end-to-end against DaVinci Resolve Studio 21.1: `tests/resolve.integration.ts` (`bun run test:integration`) builds a real project, probes, imports the exported FCPXML into a uniquely named project, renders it with the H.264 Master preset, verifies the produced bytes and resolution, then deletes its own Resolve projects. The test skips itself when scripting is unavailable. Earlier Resolve versions without bundled Python (`Contents/Applications/ResolvePython`) should use manual import.

OTIO preserves three tracks, rational times, file references and metadata. Generic OTIO has no universal mapping for the camera punch-in/audio-gain instructions; those remain metadata, so use FCPXML for these properties. OTIO was decoded with the upstream library and confirmed to contain three tracks and 72 seconds; it has not been independently imported into Resolve during this run.

Resolve exposes render settings/queue APIs, and `render` drives them headlessly: approving the rough cut starts the final render autonomously (Resolve first; an automatic FFmpeg fallback delivers the verified rough-cut bytes when Resolve cannot finish, recorded with `finalRenderEngine: "ffmpeg"`). A manual re-render with a specific preset or Fusion macro remains available.

## Finishing round trip

Manual finishing in Resolve is no longer a one-way exit; markers and finished renders come back through verified, read-only paths:

- **Markers as review notes.** Drop markers (M / Alt-M) on the timeline while reviewing in Resolve, then read them back: `wts resolve markers <project>` (IPC `resolve.markers`, Review tab → _Resolve Markers_). Each read-back persists a `ResolveMarkerReview` (artifact under `resolve/`, newest on `Project.resolveMarkers`) pinned to the plan version it was mapped against, with every marker normalized to output frames and tagged with its scene. Markers are creator feedback for the next revision — they never mutate the timeline or any approval, and a later plan revision leaves older read-backs as history.
- **Delivering a finished render.** After grading (or any manual finishing), deliver your exported master: `wts final deliver <project> /absolute/master.mp4` (IPC `final.deliver`, Review tab → _Adopt Resolve Render…_). The studio verifies the bytes against the approved plan — exact resolution, ~30 fps, audio present, duration and full decode — copies them into `renders/final-v<N>-delivered-<hash8>.<ext>`, and records `finalRenderEngine: "resolve-delivered"` plus a `final.delivered` event. Delivery requires rough-cut approval, refuses published projects, and is invalidated by plan revisions exactly like a pipeline render; publication then uploads the delivered master.

Grades authored as CDL/LUT stay out of scope for now (the next phase of deeper Resolve use); Resolve-only color management rides the deliver path above.
