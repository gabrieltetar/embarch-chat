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
  chats from Claude Code's own transcripts. A count of chats waiting on you
  shows on the icon and in the status bar; a click opens the oldest.
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
  (with the selected lines), `/` completion of the session's commands.
- **A chat is on its work item before it starts**: the extension picks the
  session id, assigns it on the desk as this panel's, then starts `claude`.
- **A chat's process closes 5 minutes after its last input or reply**,
  unless a background task runs or it waits on you; the next message resumes
  it. Chats die with their window.
- **Start work and Open chat on the Desk land here** through the desk's
  mailbox: the window whose folder matches takes the entry, once.
- **A thread this window does not run is read-only**, from its transcript,
  with Jump to the window or terminal running it.
- **Bench results show as cards**: an `embarch-api` build, flash, bootload,
  study or `serial_log` result becomes pass or fail, the board, the first
  error, steps passed and a link into embarch-ui — read from the tool result
  already in the stream.
- **Atlas citations become links** in a repo with an `embarch/atlas`:
  `<doc_id> p<N>` opens that page's text, `<board>:<ref>` the line naming it
  in the board's nets or parts.
- `claude --version` outside the tested range (2.1.287–2.1.308) shows a
  one-line warning and keeps working.

The desk is called from the extension's Node side only, on
`127.0.0.1:4891` with the token in `~/.config/embarch-desk/desk-token`;
**the webviews never hold the token**.

Not in this version: the Haiku assistant (ghost text, the 💡 cards, reply
chips, naming chats — Claude's own `ai-title` names them meanwhile) and the
📚 library menu. `src/seams.ts` is where they plug in.

## Installing

```sh
npm install
./reinstall.sh                 # build, package the .vsix, sideload it
./reinstall.sh --package-only  # build and package only
```

Reload the window afterwards. The extension is not on any marketplace, so a
VS Code server update drops it silently — re-run `./reinstall.sh`. **If the
standalone `embarch-ui-launcher` is still installed, uninstall it**: this
extension registers the same `EmbArch UI:` commands (it leaves them to the
old one while both are installed, and says so in its log).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `embarchChat.claudePath` | `"claude"` | The `claude` each chat runs. |
| `embarchChat.idleMinutes` | `5` | How long an idle chat's process lives. |
| `embarchChat.deskUrl` | `"http://127.0.0.1:4891"` | The desk. |
| `embarchChat.deskTokenPath` | `"~/.config/embarch-desk/desk-token"` | The desk's token. |
| `embarchUi.binaryPath` | `"embarch-ui"` | The embarch-ui binary the launcher starts. |
| `embarchUi.host` / `embarchUi.port` | `127.0.0.1` / `4890` | Where embarch-ui serves (also the Desk link). |
| `embarchUi.configPath` | `""` | An embarch-ui TOML config, as `EMBARCH_UI_CONFIG`. |
| `embarchUi.autoStart` | `false` | Start embarch-ui with VS Code. |

## Developing

```sh
npm run build        # esbuild: dist/extension.js, dist/webview/{chat,list}.{js,css}
npm run typecheck
npm test             # node --test: the wire, the desk client, the extension host
npm run test:webview # both webviews in headless Firefox over geckodriver
```

- **The wire tests** replay real recorded sessions (`test/fixtures/wire/`)
  through `test/fake-claude.mjs`, which checks the panel answers each
  permission prompt as the recorded session did. Record more with
  `node test/record.mjs <scratch-dir> [scenario]` (cheap, stripped Haiku
  sessions, neutral prompts) and scrub them with `test/sanitize.mjs`.
- **The desk and host tests** run against a scratch `embarch-desk` built
  from `../embarch-desk` — set `EMBARCH_DESK_BIN` to the binary; they skip
  without it. They never touch the live desk on :4891.
- `node test/live.smoke.mjs <scratch-dir> [claude]` runs one real, stripped
  Haiku chat through the wire layer (about three cents).

## Distribution

An internal `.vsix` only, never the public Marketplace.

## License

MIT — see [LICENSE](LICENSE).
