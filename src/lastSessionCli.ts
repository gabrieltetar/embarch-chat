// `node dist/last-session.js [--cwd <path>] [--turns N] [--config-dir <dir>]`:
// the previous session's last turns, for a session started with nothing to
// pick up from. The login is CLAUDE_CONFIG_DIR, as for `claude` itself.

import * as path from "path";
import { formatLastSession, lastSession } from "./lastSession";
import { projectsRoot } from "./wire/transcript";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const turns = arg("--turns");
const configDir = arg("--config-dir");
const s = lastSession({
  cwd: path.resolve(arg("--cwd") ?? process.cwd()),
  turns: turns ? Number(turns) : undefined,
  root: configDir ? path.join(configDir, "projects") : projectsRoot(),
});
console.log(formatLastSession(s));
process.exitCode = s ? 0 : 1;
