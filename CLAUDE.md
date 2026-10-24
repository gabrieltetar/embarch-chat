# embarch-chat

## Docs
**Four files, not one.** Current truth: ../embarch-doc/embarch-chat/spec.md. Why it is
that way: decisions.md — an index over decisions/, and a decision number addresses this
sub-project, not a file; cite them in code comments. 32, 33, 40, 42–47 and 49 moved to
embarch-desk as its decisions 46–55. Unresolved: open.md. Reference: interfaces.md (the
desk's routes: ../embarch-doc/embarch-desk/interfaces.md). Update them proactively per
../embarch-doc/DOC-PROTOCOL.md whenever a notable design decision, feature, or status
change happens here — §4 says when, §5 says how, and history goes in a changelog.d/
fragment (scope `chat`) rather than into a doc.

## Git
Work directly on `main` — no feature branches, no PRs (2026-08-25). Overrides the
general "branch before committing to the default branch" default, for this suite only;
ends when the repo owner explicitly says so. See ../embarch-doc/embarch-dev-workflow.md §6.

## Public repo
This repo is public: never write client names, client project names or codenames,
client internals, people's names or real issue keys — in code, tests, recorded
fixtures or commits; examples use ABC-123. Before each commit run
`python3 ../embarch-doc/scripts/check-client-names.py --repo .` and fix any hit.
Fixtures are recorded with `test/record.mjs` (sessions) and
`test/record-haiku.mjs` (the assistant's calls) in a scratch folder, with
neutral prompts, then scrubbed by `test/sanitize.mjs`. The owner's own
prompts (the assistant's prefix match reads them from `~/.claude/projects`)
stay at runtime: never in a fixture, a test or a commit.

## Build and test
`npm run build` (esbuild: extension + two Preact webviews), `npm run typecheck`,
`npm test` (node --test; the wire and assistant tests replay real recorded
sessions and Haiku calls through `test/fake-claude.mjs`, the desk and host
tests run against a scratch `embarch-desk` named by `EMBARCH_DESK_BIN`, and
the "update embarch-desk" test against an older one named by
`EMBARCH_DESK_OLD_BIN`, built from 80368bf),
`npm run test:webview` (headless Firefox). `plugin/` is the library's Claude
Code plugin; `claude plugin validate plugin` checks it.
`./reinstall.sh --package-only` builds the .vsix without installing it.
