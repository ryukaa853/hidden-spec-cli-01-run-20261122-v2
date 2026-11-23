# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ryukaa853/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ryukaa853/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor calls to a tree of files, finding the named lines at the first of three matching tiers (exact, trailing whitespace, full whitespace), and writes every change or none. Node 22 standard library only; no dependencies, no network, fully deterministic.

This is v2, a rebuild of the v1 entry (practice 100/100) aimed at the sealed final pool, whose checks test sentences of SPEC.md the practice set does not show. It reads SPEC.md more literally where v1 guessed:

- V4A: blank lines are set aside only at the end of a section, never at the end of a chunk — a blank line before the next `@@` or before `*** End of File` stays a body line of its chunk, and a section holding only blank lines has no chunk (`error: parse` at its Update File line). A whitespace-only line counts as blank.
- Unified: only zero-length lines are trimmed from the end of a hunk body — a trailing ` ` line (a context line with empty text) stays in the hunk. A hunk header accepts text directly after the closing `@@`.
- Paths: a path that exists as a directory is an `exists` failure for a create or a move target, instead of a write that cannot happen.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` / omitted to read it from standard input. Options: `--format=unified|search-replace|v4a|json|auto`, `--check` (dry run), `--strict` (exact matching only). See `SPEC.md` for the full contract; `node check.ts <practice.json>` runs the 100 practice checks.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
