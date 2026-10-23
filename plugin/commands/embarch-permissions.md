---
description: "Show EmbArch's permission split for this repo's .claude/settings.local.json and write it only on a yes"
category: "Repo setup"
disable-model-invocation: true
---

Propose EmbArch's permission split for the open repo, and write it only when I say yes.

**The rule** (suite/user-guide.md §7.1): reading and building are safe and frequent, so they are allowed; anything that reaches a board, or rewrites what EmbArch remembers about one, asks every time.

**The split, as of 2026-10-23.** The server is registered as `embarch-api`, so each rule is `mcp__embarch-api__<tool>`.

- **allow**: reads, and host-side builds that touch no hardware: `alerts`, `build`, `build_dev_bench`, `dev_bench_hello`, `list_projects`, `list_serial_ports`, `list_signals`, `list_study_streams`, `list_targets`, `serial_log`, `show_bootload_ports`, `status`, `study_status`, `study_stream_data`, `study_stream_load`, `study_watch`
- **ask**: reaches a board, or writes what EmbArch has recorded about one: `bootload`, `build_and_bootload`, `build_and_flash`, `build_and_flash_dev_bench`, `clear_bootload_ports`, `declare_bootload_ports`, `declare_signal`, `dev_bench_link`, `enroll_probe`, `flash`, `flash_dev_bench`, `mem_read`, `remove_signal`, `reset`, `reset_dev_bench`, `run_study`, `set_role_board`, `signal_exchange`, `unenroll_probe`, `validate`

`run_study` is the one to be deliberate about: with `reflash` it builds and flashes from the working tree as it stands, on both boards.

Steps:
1. Check the server's live tool list (the `mcp__embarch-api__*` tools this session has). A tool in neither list goes to **ask**, named in the summary so the split can be updated. A listed tool that no longer exists is left out.
2. Read `.claude/settings.local.json` if it exists. Merge: add the missing rules to `permissions.allow` and `permissions.ask`; never remove a rule, and never move one already placed. If one of these tools already sits in `allow`, `ask` or `deny` differently from the proposal, keep it as it is and list it as a difference.
3. Show the resulting file as a diff (the whole file if it is new), and one count line: N added to allow, M to ask, K left as they were.
4. Write it only on my yes. Never write `.claude/settings.json` (shared with the team) and never touch a file outside this repo.
5. Check that `.claude/settings.local.json` is git-ignored. If it is not, say so; do not edit `.gitignore` without asking.
