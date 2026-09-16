# ADR 005: Internal timeline plus preview and interchange exporters

Accepted 2026-09-16. The timeline represents frame-accurate clips, file/asset references, audio, layered graphics and markers independently of Resolve. FFmpeg renders cached per-scene preview segments and concatenates them. FCPXML carries finishing transforms/gain; OTIO carries tracks/times/metadata with documented property limitations. Resolve availability therefore cannot block rough-cut creation. Proxies are conformed to 720p30 for the MVP. High-resolution original-media reconform is manual.
