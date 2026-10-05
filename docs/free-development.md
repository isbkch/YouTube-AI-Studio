# Free edition development

This repository contains the public production app. Its available directors are the Purist and the Craftsman. Additional premium directors, channel strategy, YouTube analytics connection and imports, business outcomes, topic recommendations, and measured audience feedback belong in the separate private premium repository.

Public history was rewritten on 2026-09-19 to remove those implementations from branches and release tags. Use a fresh clone; do not merge or push old public or premium history back into this repository. Older downloads, clones and GitHub pull-request references cannot be recalled by a Git history rewrite.

A second rewrite on 2026-10-05 removed the premium director from public branches and release tags while preserving unrelated changes. Re-clone after this rewrite; the publishing guard also rejects history containing the former director implementation.

Enable the tracked publishing guard after cloning:

```sh
git config core.hooksPath .githooks
```

The guard rejects premium branch names, other destinations, and commits containing the old repository root or the former director introduction (including merges with old history). It cannot determine whether newly written code is commercially premium; review that boundary before publishing.

Shared fixes should start in this checkout, then be deliberately ported into the private app. Because the public history now has different commit identities, select shared changes individually instead of merging the rewritten public history wholesale into an existing premium branch.

Existing production libraries remain readable. Extra tables left by earlier versions are preserved without exposing their former workflows, so opening the free edition does not delete a creator's saved data.

Unavailable directors in saved creator settings fall back to the Craftsman. Existing plans and their approval hashes remain untouched; re-generate an unsupported storyboard with an available director before building it in the free edition.
