# Contributing to YouTube-AI-Studio

Thanks for your interest in improving YouTube-AI-Studio. This document covers
setup, the checks your change must pass, and project-specific rules that keep
the app and the CLI honest.

## Setup

You need macOS 14+ with Xcode command-line tools (Swift 6+) for the native
client, plus Node.js 24+ and Bun 1.4+ for the runtime. FFmpeg/ffprobe with
`libx264` and `libmp3lame` are needed for real renders; DaVinci Resolve and
Blender are optional.

```sh
bun install
bun run check
```

`bun run check` runs typecheck, lint, and the test suite. The normal suite uses
temporary libraries and mocked providers — it must never make paid API calls,
write outside temporary directories, or require media tools.

## Ground rules

- **Keep the domain gates in one place.** `packages/orchestrator/src/studio.ts`
  owns approvals, state transitions, and publishing rules; the CLI and the
  Swift app both call it. Do not fork domain logic into `cli.ts`, `ipc.ts`, or
  Swift — the app and the CLI must enforce the same gates.
- **IPC changes are a contract.** `apps/macos/Sources/YTAIStudio` decodes
  the private JSON-lines protocol. Keep shape changes backward-compatible with
  the Swift consumers, or update them in the same change.
- **Plans stay honest.** Times are integer frames; scenes cover the output
  contiguously; the same recording's source ranges never overlap; narration
  must be spoken inside the selected range. Any relaxation of
  `validatePlan`/`validateSources` needs a strong justification in the PR.
- **No shell, no surprises.** External tools are invoked with argument arrays;
  managed paths go through `inside`/`safePath` in `packages/shared`.
- **Engines fail closed.** Generated-media engines follow the trusted-adapter
  contract (typed plan instructions, checked-in templates, capability
  advertisement); unavailable engines must fail builds, not silently degrade.

## Changing the production plan

`packages/production-plan/src/index.ts` is authoritative for schemas, the
template catalog, validation, migration, and patches. If you touch it:

1. Bump the plan schema version and migrate legacy plans when appropriate.
2. Regenerate the checked-in JSON Schemas with `bun run schema`.
3. Extend the catalog assertions and render cases in `tests/m2.test.ts` and
   `tests/media.integration.ts`.

Adding a graphic template means updating `graphicSchema`, `TEMPLATE_CATALOG`,
the trusted Remotion component/dispatch, affected Swift display/edit support,
and the regenerated schemas and tests. Keep Remotion dependency versions
aligned with the renderer identity in `graphicKey`.

## Testing

```sh
bun run test                                       # mocked unit/domain/IPC tests
node --import tsx --test tests/domain.test.ts      # one file
bun run test:integration                           # real FFmpeg/Remotion (tools required)
bun run demo                                       # end-to-end synthetic production
```

Integration tests and the demo are not run in CI; run them when you touch
media handling, rendering, or the build graph.

## Style and hygiene

- TypeScript is strict ESM with NodeNext resolution and direct `.ts` imports.
- Format with Prettier (`bun run format`); Swift is excluded and formatted via
  `bun run swift:format`.
- Never commit `.env` files, credentials, API keys, or personal media. Run
  `bun run wts doctor` when documenting tool-dependent behavior.
- Keep commit messages descriptive; the history uses Conventional Commits
  style (`feat:`, `fix:`, `chore:`, …).

## Pull requests

- Describe the user-visible behavior change and the design in a sentence or two.
- Link any related issue.
- Include the output of `bun run check` (CI runs it on every PR).
- Note when a change alters the IPC protocol, the plan schema, or an approval
  gate.

Report security vulnerabilities privately — see [SECURITY.md](SECURITY.md),
not public issues. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md). This project is licensed under the
[Elastic License 2.0](LICENSE), and you agree that your contributions will be
licensed under it as well.
