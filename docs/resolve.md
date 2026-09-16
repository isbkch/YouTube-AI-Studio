# DaVinci Resolve support

The MVP exports both FCPXML 1.8 and OTIO, plus the application-neutral timeline JSON. The **FCPXML is the primary finishing handoff**: it includes a conformed A-roll track, narration audio, connected full-frame graphics, scene markers, punch-in sizing and audio gain. It references local files with encoded file URLs. Move/back up the whole project; moving it later requires Resolve media relinking or a regenerated export.

The export uses 720p/30fps proxies for reliable rough-cut timing, including footage originally recorded at a fractional or variable frame rate. Original imported recordings remain available in the project for manual reconform and final grading. Automatic original-resolution reconform, grading, complex transitions, mixed source frame rates in final delivery, Fusion compositing and final delivery presets are outside this MVP.

## Manual import (works independently of external scripting)

1. Create or open the intended Resolve project.
2. Choose **File → Import → Timeline…** (Shift-Command-O on this installation).
3. Select the `.fcpxml` in the project's `renders` directory.
4. Keep source-clip import and sizing information enabled. The importer should report **1280×720, 30 fps**.
5. Inspect V1 presenter clips, V2 generated graphics, A1 narration and scene timing.

Verified on the installed Resolve 21.1: the generated demo imported into the isolated **WTS MVP Export Verification** project, showed a **00:01:12:00** timeline, loaded all media, displayed the architecture animation over preserved A-roll, and showed narration waveforms. The project was saved. This was a manual import verification through Resolve's UI; the production adapter itself does not automate the UI.

## Scripting adapter

The installed vendor documentation confirms `ProjectManager.CreateProject`, `MediaPool.ImportTimelineFromFile` (AAF/EDL/XML/FCPXML/DRT/ADL/OTIO), timeline track inspection, and render APIs. Resolve 21.1 bundles a Python interpreter at `Contents/Applications/ResolvePython` with its scripting module available out of the box.

The trusted `bridge.py` supports two allowlisted actions:

- `probe`: connect and report product/version.
- `import`: create a uniquely named project, import a supplied generated timeline, save it and return track/duration information. It refuses to overwrite an existing named project.

```sh
bun run wts resolve probe
bun run wts resolve import /absolute/path/to/resolve-v2-HASH.fcpxml "My new Resolve project"
```

External scripting requires a running, fully loaded Resolve instance and an edition/preferences configuration that permits local connections. It is not enabled by this app. On this development machine, the API probe returned no connection even while Resolve was open. Therefore **direct scripted import is implemented but not verified here**; manual FCPXML import is verified. Earlier Resolve versions without bundled Python should use manual import until an explicitly configured interpreter adapter is added.

OTIO preserves three tracks, rational times, file references and metadata. Generic OTIO has no universal mapping for the camera punch-in/audio-gain instructions; those remain metadata, so use FCPXML for these properties. OTIO was decoded with the upstream library and confirmed to contain three tracks and 72 seconds; it has not been independently imported into Resolve during this run.

Resolve exposes render settings/queue APIs, but this MVP does not call them. Final finishing/render remains in Resolve under human control. The local FFmpeg preview remains useful with Resolve closed or unavailable.
