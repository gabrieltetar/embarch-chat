# EmbArch Chat

A Claude Code chat of the owner's own, as a VS Code extension: it replaces
Claude Code's panel for EmbArch work, knows each chat's work item, and shows
every thread of the window's desk at a glance, waiting-on-you first. It also
carries the [embarch-ui](../embarch-ui) launcher, which moved in from
embarch-ui's own `vscode-extension/`.

The design is in three proposals in `embarch-doc` —
[the chat](../embarch-doc/embarch-chat-proposal.md),
[the desk's side](../embarch-doc/embarch-chat-desk-proposal.md) and
[the Haiku assistant](../embarch-doc/embarch-chat-assistant-proposal.md) —
whose decision numbers the code cites.

## What it does

- **The thread list** sits behind its own activity-bar icon: the window's
  desk's threads grouped by work item, waiting-on-you first, Untracked last —
  this window's chats, sessions in a terminal or Claude Code's panel, and past
  chats from Claude Code's own transcripts. A window on another desk than
  the open one asks the desk for its own desk's cards. A count of chats
  waiting on you off screen shows in the status bar, and on the icon once
  the list has been opened (VS Code builds a view only when first shown);
  a click opens the oldest.
- **A chat** opens in the secondary sidebar, where Claude Code's panel is, or
  as an editor tab. Its header is the work item's card in two lines: issue
  key and title, a status dropdown, PRs with their state, today's time, a
  link to the Desk, the context meter with Compact.
- **The wire is Claude Code's own.** Each chat runs one `claude` from `PATH`
  with the official panel's flags (`--input-format stream-json
  --output-format stream-json --permission-prompt-tool=stdio
  --setting-sources=user,project,local --replay-user-messages
  --include-partial-messages`, `--session-id` for a new chat, `--resume` to
  come back). Streamed text, tool calls, permission prompts, Claude's
  questions as forms, plans with approve and keep planning, Stop, the mode
  and model switches, subagent steps nested under their call, Edit and Write
  as diffs that open VS Code's diff editor, `@` completion of workspace paths
  (with the selected lines), `/` completion of the session's commands. A
  tool's whole input or output opens in a read-only editor tab (a Bash
  output as a log, JSON as JSON) — a 100K serial or build log gets search
  and the minimap.
- **In Ask mode a pending Edit or Write is taken change by change**: its
  diff tab has a Reject on each change (a CodeLens) and Accept and Reject
  in the title bar; Accept — or the card's Allow — sends an input that
  makes only the kept changes (a Write's content, an Edit's `new_string`).
  An Edit with `replace_all` is taken whole.
- **An open file's unsaved changes are saved before Claude reads, edits or
  writes it**, as Claude Code's own panel does: a PreToolUse hook declared
  in the CLI's `initialize`, which the CLI calls back over stdio and waits
  on (at most 5 s).
- **Claude can read the Problems panel** when `embarchChat.diagnosticsTool`
  is on (off by default): Claude Code's own `getDiagnostics` IDE tool,
  served by the extension as an MCP server over the chat's stdio — named in
  `initialize`, spoken to as `mcp_message` control requests; no process, no
  port, no lock file.
- **A chat is on its work item before it starts**: the extension picks the
  session id, assigns it on the desk as this panel's, then starts `claude`.
- **A chat's process closes 5 minutes after its last input or reply**,
  unless a background task runs or it waits on you; the next message resumes
  it — one written while it is closing goes to the resumed process. Chats
  die with their window — except across a reload: the chats it had on
  screen come back (the sidebar's and its tabs), and one cut off mid-turn
  resumes with the CLI's own `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, which
  reruns the interrupted step, labelled "Continuing the step that was
  interrupted when the window reloaded." (at most twice before a turn
  finishes, never for a step over an hour old; otherwise, or with
  `embarchChat.continueAfterReload` off, it says no reply follows). VS Code
  cannot tell a reload from a close: a window back within 90 s of its last
  note is a reload.
- **Start work and Open chat on the Desk land here** through the desk's
  mailbox: the window whose folder matches takes the entry, once.
- **A thread this window does not run is read-only**, from its transcript,
  with Jump to the window or terminal running it. A past one in this
  window's folder resumes here with the next message — only when `claude
  agents` lists nothing running it — and keeps its work item and its time
  on the desk.
- **Bench results show as cards**: an `embarch-api` build, flash, bootload,
  study or `serial_log` result becomes pass or fail, the board, the first
  error, steps passed and a link into embarch-ui — read from the tool result
  already in the stream. A `serial_log` whose log holds an assert failure,
  a panic, a hard fault or a fatal error is a FAIL, the line shown — by
  their whole markers (`ASSERTION FAIL`, `ZEPHYR FATAL ERROR`, `HARD
  FAULT`, `panicked at`, ...), so a pin that is "asserted" is no failure.
- **Atlas citations become links** in a repo with an `embarch/atlas`:
  `<doc_id> p<N>` opens that page's text, `<board>:<ref>` the line naming it
  in the board's nets or parts.
- `claude --version` outside the tested range (2.1.287–2.1.308) shows a
  one-line warning and keeps working.
- **The Haiku assistant at the input**, for the chat on screen only, in
  three waves: at once, typing through the ghost text shown and a prefix
  match over your own prompts of the last 30 days (read from Claude Code's
  transcripts at runtime, kept in memory only); after a 300 ms pause,
  Haiku's ghost text, streamed — Tab takes it; after a 2 s pause, or just
  before a longer draft goes, Haiku's cards behind the 💡, one submenu per
  kind: missing context, improvements, context handling. **Every card is an
  edit to the draft**: hovering previews it in place (added words grey,
  removed ones struck through), a click applies it, Ctrl+Z restores. The
  compact card adds `/compact focus on: …` as a first line, and Enter sends
  that, waits for the compaction, then sends the rest (Stop, or a failed
  compaction, puts the rest back in the draft instead); the handoff card
  turns the draft into a request for a handoff; the background card asks
  for a background subagent. The next keystroke cancels a stale call.
- **Reply chips after each turn**: two to four, Claude Code's own guess
  (`--prompt-suggestions`) among them; a click sends one. After a turn that
  wrote a handoff, **Fresh chat with this handoff** starts a new chat on the
  same work item with it. **Haiku names each new chat** after its first turn
  (`rename_session`, so Claude Code's own history shows the name too).
- Each assistant call is one stripped `claude -p --model haiku` (thinking
  off, no tools, no MCP, no settings, unsaved, streamed, the prompt on
  stdin, `EMBARCH_DESK_INTERNAL=1`), about $0.002; it sees the draft,
  Claude's last reply, the work item's card, the library's names and the
  context usage. The calls and their cost are in the log.
- **The 📚 library** beside the 💡: this repo's own plugin (`plugin/`) and
  your `~/.claude/commands`, one submenu per `category:` in each entry's
  frontmatter (none is Other); a click puts `/<name> ` at the head of the
  draft, as the session knows it (`/embarch-chat:<name>` for the plugin's).
  `/` completes them too.
- **It looks like EmbArch over VS Code's own theme**: the UI text in IBM
  Plex Sans, shipped in the extension (code, diffs and tool output keep the
  editor's font); EmbArch's cyan accent and its green, amber, red and blue
  for done, waiting on you, failed and running, over VS Code's backgrounds,
  text, inputs and borders, in a dark or a light theme (a high-contrast one
  keeps VS Code's colours). The EmbArch mark is the activity bar's icon,
  the chat tab's and **EmbArch** at the right of the status bar, which
  starts a new chat.

- **What goes into a message**, as Claude Code's own panel builds it. A
  pasted screenshot is a thumbnail under the input (× takes it off) and
  goes as an image block — an image alone sends; a screenshot that WSL's
  clipboard hands over as raw bytes pastes nothing. A paste over 800
  characters or 2 line breaks goes in the message's `inline_pastes`, which
  the CLI marks as pasted; invisible characters (zero widths, bidi
  overrides, tags) are stripped from a paste, and from a draft before it
  goes — the first Enter shows the cleaned draft, the second sends it.
  **The open file, or the selected lines with their text, go with each
  message** as Claude Code's `<ide_opened_file>` / `<ide_selection>` block,
  shown as a chip under the input with an ×; the same one does not go
  twice, and a slash command goes without it. **A terminal picked from the
  `@` list** goes as a chip too: when the message goes, its last 100 lines
  are read (the terminal is selected and copied, as Claude Code does it —
  VS Code gives no other way — and the clipboard put back) and sent as a
  `<terminal name="…">` block. Each shows as a row under the sent message,
  opening to its text.
- **`/btw <question>` asks a side question** while Claude works: the CLI's
  `side_question` answers it from the conversation and the turn in
  progress; question and answer show above the input and never join the
  conversation. Clear drops them. **The 💬 beside the 📚** does the same as a
  mode: the input is tagged "Side question", every Enter asks aside, and Esc
  or a second click leaves it with the draft kept; it is off until the chat
  has a conversation this window runs.

- **Keys**, after Claude Code's own: **Ctrl+Alt+Esc** focuses the chat's
  input from an editor (with lines selected, it brings them as an
  @-mention) and again leaves it; **Alt+Shift+K** inserts the editor's file
  and selected lines as `@path#L10-24` at the input's caret;
  **Ctrl+Shift+T** reopens the last closed chat tab while a chat tab was
  the last tab closed, else VS Code's own reopen. Claude Code binds
  Ctrl+Esc and Alt+K wherever an editor has focus, so with both installed
  those chords stay Claude Code's.

The desk is called from the extension's Node side only, on
`127.0.0.1:4891` with the token in `~/.config/embarch-desk/desk-token`;
**the webviews never hold the token**.

**A link opens once, through the extension**: an http(s) link in a reply
opens in the browser, a path in the editor; a `vscode:`, `mailto:`,
`command:` or any other URI is shown, not opened. No link in the webviews
carries an `href`, so VS Code's own handler for clicked links (which would
open it a second time, and open `vscode:` links the extension refuses)
never sees one.

## The library's plugin

`plugin/` is a Claude Code plugin — the library's generic entries:
`/embarch-permissions` and `/embarch-claude-md` (show what they would write
into the open repo, and write it only on a yes) and the `build-flash-verify`
skill (the build → flash → serial log → diagnose loop). The repo root is its
marketplace (`.claude-plugin/marketplace.json`). An entry naming a client
belongs in `~/.claude/commands`, never here. The extension ships a copy for
the 📚, but a chat can run an entry only once the plugin is installed in
Claude Code:

```sh
claude plugin marketplace add /path/to/embarch-chat
claude plugin install embarch-chat@embarch-chat
```

Until then a started chat shows the plugin's entries greyed.

## Installing

```sh
npm install
./reinstall.sh                 # build, package the .vsix, sideload it
./reinstall.sh --package-only  # build and package only
```

**It needs embarch-desk b722b3b or later** — deploy the desk with it. An
older desk ignores `/view?desk=` (a window on another desk than the open
one would get the open desk's cards) and does not keep which chats run
here; the list then says "Update embarch-desk" and shows only chats in the
window's repos.

Reload the window afterwards. The extension is not on any marketplace, so a
VS Code server update drops it silently — re-run `./reinstall.sh`. **If the
standalone `embarch-ui-launcher` is still installed, uninstall it**: this
extension registers the same `EmbArch UI:` commands (it leaves them to the
old one while both are installed, and says so in its log).

## Settings

Every setting below is **machine-scoped**: VS Code takes it from your user
settings, or in a WSL window from the **Remote [WSL]** settings
(`~/.vscode-server/data/Machine/settings.json`), never from a workspace's
`.vscode/settings.json` — a cloned repo cannot point the chat at another
`claude`, the desk's token at another server, or the launcher at another
binary, turn the assistant back on after you turned it off, or keep chats'
processes up. In a WSL window a value set in the local user settings does not
apply; set it in the Remote settings. The desk URL must be this machine's
(`127.0.0.1`, `::1` or `localhost`): the extension calls nothing else.
The extension does not run in an untrusted workspace.

| Setting | Default | Meaning |
|---|---|---|
| `embarchChat.claudePath` | `"claude"` | The `claude` each chat runs. |
| `embarchChat.idleMinutes` | `5` | How long an idle chat's process lives. |
| `embarchChat.deskUrl` | `"http://127.0.0.1:4891"` | The desk. |
| `embarchChat.deskTokenPath` | `"~/.config/embarch-desk/desk-token"` | The desk's token. |
| `embarchChat.assistant` | `true` | The Haiku assistant: ghost text, cards, chips, naming. Off, the instant prefix match and the CLI's own suggestion remain. |
| `embarchChat.autosave` | `true` | Save an open file's unsaved changes before Claude reads, edits or writes it. |
| `embarchChat.continueAfterReload` | `true` | After a reload, a chat cut off mid-turn continues the interrupted step. |
| `embarchChat.diagnosticsTool` | `false` | Give Claude `getDiagnostics`, the Problems panel (its definition rides in every chat's tool list). |
| `embarchChat.attachOpenFile` | `true` | The file open in the editor goes with each message. Off, a file goes only with selected lines. |
| `embarchChat.attachSelection` | `true` | The selected lines, with their text, go with each message. Off, `@` still inserts them. |
| `embarchUi.binaryPath` | `"embarch-ui"` | The embarch-ui binary the launcher starts. |
| `embarchUi.host` / `embarchUi.port` | `127.0.0.1` / `4890` | Where embarch-ui serves (also the Desk link). |
| `embarchUi.configPath` | `""` | An embarch-ui TOML config, as `EMBARCH_UI_CONFIG`. |
| `embarchUi.autoStart` | `false` | Start embarch-ui with VS Code. |

## Developing

```sh
npm run build        # esbuild: dist/extension.js, dist/webview/{chat,list}.{js,css}
npm run typecheck
npm test             # node --test: the wire, the assistant, the desk client, the extension host
npm run test:webview # both webviews in headless Firefox over geckodriver
```

- **The wire tests** replay real recorded sessions (`test/fixtures/wire/`)
  through `test/fake-claude.mjs`, which checks the panel answers each
  permission prompt as the recorded session did. Record more with
  `node test/record.mjs <scratch-dir> [scenario]` (cheap, stripped Haiku
  sessions, neutral prompts) and scrub them with `test/sanitize.mjs`.
- **The desk, host and resume tests** run against a scratch `embarch-desk`
  built from `../embarch-desk` — set `EMBARCH_DESK_BIN` to the binary; they
  skip without it. They use ports 4980–4989 only (`test/scratch-desk.mjs`
  says which test takes which), their own data, config and
  `CLAUDE_CONFIG_DIR`, and never touch the live desk on :4891. A `start`
  mailbox entry is seeded into the scratch desk's store, as Start work
  would leave it: the desk refuses one posted to `/mailbox`.
- **The glyph** — the status bar's icon font, the activity bar's icon and
  the chat tab's pair (`media/embarch-glyph.*`, `media/embarch-tab-*.svg`)
  — is made from the mark (`tools/embarch-mark.svg`, embarch-ui's) by
  `tools/make_glyph.py`, which needs fontTools and skia-pathops in a scratch
  venv; its docstring says how to run it.
- `node test/live.smoke.mjs <scratch-dir> [claude]` runs one real, stripped
  Haiku chat through the wire layer (about three cents).
- **The assistant tests** replay real recorded Haiku calls
  (`test/fixtures/haiku/`, by the prompt's `TASK:` line) through the same
  fake. Record more with `node test/record-haiku.mjs <scratch-dir>
  [scenario]` — neutral drafts and a made-up work item only, never your own
  prompts — and scrub them with `test/sanitize.mjs`. The prompt history is
  tested on synthetic transcripts; the host test points `CLAUDE_CONFIG_DIR`
  at a scratch folder.

## Distribution

An internal `.vsix` only, never the public Marketplace.

## License

MIT — see [LICENSE](LICENSE). IBM Plex Sans
(`webview/shared/fonts/`) is the SIL Open Font License 1.1 — see
[its licence](webview/shared/fonts/LICENSE-IBM-Plex.txt), which the
`.vsix` carries beside the font.
