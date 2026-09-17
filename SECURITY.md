# Security Policy

WinTheCloud Studio is a local, creator-run application: SwiftUI talking to a
private local runtime over stdio, with no web frontend, HTTP server, or cloud
backend. Publishing goes through the local `youtubeuploader` CLI under an
explicit creator approval, and the project never handles OAuth credentials
itself.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via
[GitHub security advisories](https://github.com/isbkch/yt-ai-studio/security/advisories/new)
("Report a vulnerability"). Do not open public issues for security reports.

Include what you can of: affected component or file, a minimal reproduction,
impact, and suggested mitigation. You will hear back within a few days. Please
avoid public disclosure until a fix is released.

## Scope

In scope:

- Anything in this repository: the Swift client, the TypeScript runtime and
  workspace packages, checked-in Remotion/Blender templates, and build scripts.
- Unsafe handling of project/media files, path traversal around the managed
  library, shell-injection risks in tool invocation, and secret leakage into
  project files or logs.

Out of scope:

- Vulnerabilities in third-party tools the studio drives (FFmpeg, whisper.cpp,
  DaVinci Resolve, Blender, `youtubeuploader`) — report those upstream.
- Your own API keys, `.env` contents, or OAuth assets; the project stores keys
  in the macOS Keychain and expects users to keep them private.
- The behavior of billed providers (OpenAI, Google) beyond how this codebase
  calls them.

## Hardening expectations for contributors

- External tools run with argument arrays, never through a shell.
- Managed paths must go through `inside`/`safePath` in `packages/shared`.
- Never log or persist credentials; the Keychain is the only secret store.
- Add tests for new parser/import paths that consume untrusted files
  (transcripts, plans, FCPXML bundles, packaging documents).
