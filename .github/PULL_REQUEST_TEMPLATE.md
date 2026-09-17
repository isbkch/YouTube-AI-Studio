## Summary

What changes for the user, and the shape of the implementation.

## Area

Which parts this touches (native client / runtime / plan schema / media /
agents / engines / docs), and whether any approval gate, IPC shape, or plan
schema version is affected.

## Testing

- [ ] `bun run check` passes (typecheck, lint, mocked tests)
- [ ] Integration or demo run if media/render/build paths changed
      (`bun run test:integration`, `bun run demo`)
- [ ] JSON Schemas regenerated (`bun run schema`) and catalog/render tests
      extended if the plan or template catalog changed
- [ ] Swift consumers updated if the IPC protocol changed

## Notes

Anything reviewers should weigh (trade-offs, migration behavior, follow-ups).
