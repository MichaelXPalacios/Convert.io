# Imported skills: pstack

Six `principle-*` skills in this directory are copied verbatim from
[cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), by
Lauren Tan (poteto), MIT licensed, Copyright (c) 2026 Lauren Tan. The full
licence text is in that repository.

## Why these six and not the other thirty

pstack is a Cursor plugin. Its entry points (`/setup-pstack`, `/poteto-mode`)
and its `agents/` and `automations/` directories are Cursor-specific and were
not imported — they would not run here. What does port is the `skills/`
directory, because a skill is a `SKILL.md` with `name` and `description`
frontmatter in both tools.

Each of these was chosen against a mistake already made in this repository,
not because the catalogue looked good:

| Skill                                          | The incident it addresses                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `principle-prove-it-works`                     | Twice an empty result was read as success: a secret scan whose `--cached` flag was misplaced so it errored and printed nothing, and a claim that ESLint ignored `.github/` "verified" by counting grep matches in `--debug` output. Both were answered by running the real command and reading its exit code. |
| `principle-separate-before-serializing-shared-state` | Two agents share one working tree and one `.git`. A `git add -A` swept the other's files, a `git push` published commits their author had deliberately withheld, and adding a workspace package conflicted an open PR's lockfile. |
| `principle-make-operations-idempotent`         | The migration runner, the seed, the exposure write and the recompute are each idempotent, and each had to be made so deliberately. This is the invariant to keep.                                                                 |
| `principle-fix-root-causes`                    | `prettier --check` failing on a fresh Windows clone was fixed with `.gitattributes` rather than by excluding the files.                                                                                                           |
| `principle-test-behavior-not-implementation`   | The worker's tests assert the posterior a known traffic pattern must produce, not that the functions were called.                                                                                                               |
| `principle-boundary-discipline`                | `packages/contracts` is the interface freeze; validation concentrates there and at the HTTP edge.                                                                                                                                |

## Two things to know

The frontmatter keeps `disable-model-invocation: true`, which is a Cursor key.
The files are unmodified so the copies stay faithful to the licence; if a skill
turns out not to fire automatically here, removing that one line from its
frontmatter is the fix.

`.claude/skills/` is also written by `neon skills`, which regenerates its own
eight directories and maintains `skills-lock.json`. Nothing observed suggests
it removes directories it does not own, but if a `neon skills` run ever
clears these, that is why.
