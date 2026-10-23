---
name: build-flash-verify
description: "The firmware loop on EmbArch hardware: build, read the compiler errors, fix, rebuild, flash, reset, capture the serial log, check the expected behaviour, repeat. Use when asked to make firmware compile (\"fix the build\"), to get a change working on the board, or to prove a change on hardware with embarch-api's tools."
category: "Bench"
---

# Build, fix, flash, verify

The loop the suite exists for: the agent sees the real compiler output and the real board, and iterates without the user relaying either. The tools are embarch-api's.

## Before the first build

- `list_projects` once, for the project name and its boards and variants. With no project named, embarch-api builds the open desk's firmware repo.
- **Write down what "working" means before touching hardware**: the log line, the shell reply, the LED, the measured value, taken from the user's words or the issue. If nobody said, ask once. Never infer what the device should do from its source.

## The loop

1. **Build**: `build` with the selection needed (`board`, `variant`, `revision`, `app`, `snippets`, `extra_args`). It uses EmbArch's own build directory and touches no hardware, so iterate freely.
2. **Read the errors**: the result carries the exit code, truncated stdout/stderr and whether a fresh artifact was found. The first error is the one that matters; later ones often cascade. A success without a fresh artifact is a configuration problem (the build wrote somewhere else), not a pass.
3. **Fix** the first real error and rebuild. If three builds in a row fail on the same error, stop and show it: the cause is probably not where you are editing.
4. **Flash**: `flash` when the build is already done, or `build_and_flash`, which flashes only after a successful build with a fresh artifact. `erase` stays false unless the user asked. Flashing asks for approval, so say what is about to be flashed.
5. **Reset**: `flash` does not reset the target. Call `reset`, or the old image keeps running and looks like a failed flash.
6. **Capture**: `serial_log` on the project's port, else one from `list_serial_ports` (names as Core's machine sees them, e.g. COM ports when Core runs on Windows). It is a bounded snapshot of at most 10 s, and output printed before it opens is lost, so reset again with a capture ready if the boot banner is the proof. A DUT with no wired console: `signal_exchange` on a declared shell signal, or ask how success is visible.
7. **Check** against what you wrote down. Pass: report. Fail: find the first fault in the log (assert, fault dump, reboot loop), form one hypothesis, change one thing, go back to 1.

## Stop and report

- Report: builds run, each fix with file:line, what was flashed (board, artifact), the log lines that prove the result, and the verdict against the stated expectation.
- Stop and ask when the board is not seen (`status`, `list_serial_ports`), a physical action is needed, the fix would change behaviour beyond the request, or the same failure survives two different fixes.
- When a misconfiguration is beyond what the tools' errors explain, run `embarch doctor --json`.
- On a desk work item, add one line with `desk_add_line` for a hardware result that ends without a commit.
