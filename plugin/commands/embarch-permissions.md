---
description: "Show EmbArch's permission split for this repo's .claude/settings.local.json and write it only on a yes"
category: "Repo setup"
disable-model-invocation: true
---

Propose EmbArch's permission split for the open repo, and write it only when I say yes.

**The rule** (suite/agent-guide.md §1.1): reading and building are safe and frequent, so they are allowed; anything that reaches a board, or rewrites what EmbArch remembers about one, asks every time.

**The split, as of 2026-11-23** (suite/agent-guide.md §1.1, revised by `doc/099`). A Live session's reads and resets run under the bench lease, which Core enforces, so they are free. The `embarch-api` server is registered as `embarch-api`, so each rule is `mcp__embarch-api__<tool>`.

- **allow**: reads, host-side builds that touch no hardware, resets, and the lease calls: `alerts`, `bench_exchange`, `build`, `build_dev_bench`, `build_each`, `bundle`, `call_log`, `capture_read`, `capture_start`, `capture_stop`, `core_state`, `dev_bench_hello`, `lease_release`, `lease_renew`, `lease_show`, `lease_take`, `ledger_pending`, `ledger_show`, `list_instruments`, `list_projects`, `list_serial_ports`, `list_signals`, `list_study_streams`, `list_targets`, `mem_read`, `reset`, `reset_dev_bench`, `serial_log`, `show_bootload_ports`, `signal_exchange`, `status`, `study_measurements`, `study_status`, `study_stream_data`, `study_stream_load`, `study_watch`, `validate`
- **ask**: flashing and bootloading, and what writes what EmbArch has recorded or answers for you: `answer_prompt`, `bootload`, `build_and_bootload`, `build_and_flash`, `build_and_flash_dev_bench`, `clear_bootload_ports`, `declare_bootload_ports`, `declare_instrument`, `declare_signal`, `dev_bench_link`, `enroll_probe`, `flash`, `flash_dev_bench`, `ledger_add`, `publish`, `remove_instrument`, `remove_signal`, `run_host_study`, `run_study`, `set_role_board`, `unenroll_probe`

The atlas's server is registered as `embarch-atlas`, so each rule is `mcp__embarch-atlas__<tool>`.

- **allow**: its static lookups and, on a Live board, the lease-gated reads: `applies`, `code`, `config`, `core_state`, `decode`, `doc_section`, `doc_toc`, `dt_node`, `find_fact`, `find_text`, `footprint`, `live_stacks`, `mismatch_report`, `net_find`, `net_trace`, `part_card`, `parts`, `pin_trace`, `rc_timing`, `reg_read`, `register`, `schematic_text`, `shell`, `shell_commands`, `shell_run`, `stacks`, `states`, `transitions`
- **ask**: `reg_read_bank` (writes a page select) and `reg_read_clear` (reads a register whose read clears a flag or pops a FIFO)

`run_study` is the one to be deliberate about: with `reflash` it builds and flashes from the working tree as it stands, on both boards. `answer_prompt` relays your answer to a host study waiting on a person, and a lab supply or load is driven only by a host study's `Instrument` step, run with `run_host_study`: both ask, so the person stays the one deciding. `publish` writes a signed deliverable, so it asks.

Steps:
1. Check each server's live tool list (the `mcp__embarch-api__*` and `mcp__embarch-atlas__*` tools this session has). A tool in neither of its server's lists goes to **ask**, named in the summary so the split can be updated. A listed tool that no longer exists is left out; a server this session does not have gets no rules.
2. Read `.claude/settings.local.json` if it exists. Merge: add the missing rules to `permissions.allow` and `permissions.ask`; never remove a rule, and never move one already placed. If one of these tools already sits in `allow`, `ask` or `deny` differently from the proposal, keep it as it is and list it as a difference.
3. Show the resulting file as a diff (the whole file if it is new), and one count line: N added to allow, M to ask, K left as they were.
4. Write it only on my yes. Never write `.claude/settings.json` (shared with the team) and never touch a file outside this repo.
5. Check that `.claude/settings.local.json` is git-ignored. If it is not, say so; do not edit `.gitignore` without asking.
