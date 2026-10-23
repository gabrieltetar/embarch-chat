# embarch-chat

## Docs
**Not folded yet.** Until the fold creates `../embarch-doc/embarch-chat/` (spec.md,
decisions.md, open.md), the design lives in three proposals at the doc repo's root:
../embarch-doc/embarch-chat-proposal.md (the chat itself, decisions 1–39 and 41),
../embarch-doc/embarch-chat-desk-proposal.md (the desk's side and the **Interface**
table — the contract for every desk call this extension makes), and
../embarch-doc/embarch-chat-assistant-proposal.md (the Haiku assistant). Decision
numbers are shared across the three and permanent; cite them in code comments.
Update them proactively per ../embarch-doc/DOC-PROTOCOL.md whenever a notable design
decision, feature, or status change happens here — §4 says when, §5 says how, and
history goes in a changelog.d/ fragment rather than into a doc.

## Git
Work directly on `main` — no feature branches, no PRs (2026-08-25). Overrides the
general "branch before committing to the default branch" default, for this suite only;
ends when the repo owner explicitly says so. See ../embarch-doc/embarch-dev-workflow.md §6.

## Public repo
This repo is public: never write client names, client project names or codenames,
client internals, people's names or real issue keys — in code, tests, recorded
fixtures or commits; examples use ABC-123. Before each commit run
`python3 ../embarch-doc/scripts/check-client-names.py --repo .` and fix any hit.
Fixtures are recorded with `test/record.mjs` in a scratch folder, with neutral
prompts, then scrubbed by `test/sanitize.mjs`.

## Build and test
`npm run build` (esbuild: extension + two Preact webviews), `npm run typecheck`,
`npm test` (node --test; the wire tests replay real recorded sessions through
`test/fake-claude.mjs`, the desk tests run against a stub desk).
`./reinstall.sh --package-only` builds the .vsix without installing it.
