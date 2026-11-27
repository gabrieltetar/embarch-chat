// A login of kind container (decision 122): the spawn spec, the handoff, the
// transcripts and what `initialize` declares. No container runtime runs: the
// runtime is a stand-in that records its argv, its environment and the first
// line it is sent.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const core = createRequire(import.meta.url)("../test-out/core.js");
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "embarch-chat-container-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const tmp = (p) => fs.mkdtempSync(path.join(ROOT, p));

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";

// The text `embarch init --container` writes (toml::to_string of a ContainerRecord).
const RECORD = `# Written by \`embarch init --container\`; edit the plan, not this file.
name = "fw"
runtime = "podman"
topology = "linux"
topology_verified = true
image_tag = "embarch-agent:abc"
core_port = 4884
run_args = [
    "run",
    "--detach",
    "--name=embarch-agent-fw",
    "--mount=type=bind,source=/etc/agents/fw,target=/etc/embarch-agent,readonly",
    "--mount=type=bind,source=/home/o/.local/share/embarch/agents/fw/claude-config,target=/home/agent/.claude",
    "--mount=type=bind,source=/home/o/src/fw,target=/person/repo,readonly",
    "--env=EMBARCH_CORE_ADDR=<core-addr>",
    'weird "quoted" arg',
]
run_args_sha256 = "00"

[network]
allow = ["<core-addr>:4884", "api.anthropic.com"]
`;

const login = core.parseContainerRecord(RECORD);

test("the record gives the container, the runtime, the repo and the exchange folder", () => {
  assert.deepEqual(login, {
    container: "embarch-agent-fw",
    runtime: "podman",
    repo: "/home/o/src/fw",
    exchange: "/home/o/.local/share/embarch/agents/fw",
    manifestPath: "fw",
  });
  assert.equal(core.parseContainerRecord(RECORD, { manifestPath: "ws/fw/" }).manifestPath, "ws/fw");
  assert.throws(() => core.parseContainerRecord(RECORD, { manifestPath: "../x" }), /manifestPath/);
  assert.throws(() => core.parseContainerRecord(RECORD.replace(/\s*"--mount=type=bind,source=\/home\/o\/src\/fw[^\n]*/, "")), /repo/);
  assert.throws(() => core.parseContainerRecord(RECORD.replace('runtime = "podman"', 'runtime = "lxc"')), /runtime/);
});

test("the spawn spec: the runtime runs `exec -i -u agent -w /work/<repo> <name> claude`, then today's flags", () => {
  const spec = { claudePath: "ignored", cwd: "/host/fw", sessionId: NEW, resume: false, permissionMode: "default", container: login };
  const args = core.claudeArgs(spec);
  assert.deepEqual(args.slice(0, 8), ["exec", "-i", "-u", "agent", "-w", "/work/fw", "embarch-agent-fw", "claude"]);
  assert.deepEqual(args.slice(8), core.claudeArgs({ ...spec, container: undefined }));
  assert.deepEqual(args.slice(8, 12), ["--input-format", "stream-json", "--output-format", "stream-json"]);
  assert.ok(args.includes("--session-id") && args.includes(NEW));
});

test("the client's environment is an allowlist: nothing else of the host's reaches the spawn", () => {
  const env = core.containerEnv({ PATH: "/bin", HOME: "/home/o", XDG_RUNTIME_DIR: "/run/user/1000", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "t", CLAUDE_CONFIG_DIR: "/c", SSH_AUTH_SOCK: "/s", EMBARCH_DESK_DATA_DIR: "/d" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/o", XDG_RUNTIME_DIR: "/run/user/1000" });
});

// A runtime stand-in: logs its argv and environment and the first line on stdin, then exits (or fails with the text of stderr.txt beside it, its environment being the allowlist).
function fakeRuntime(dir) {
  const file = path.join(dir, "runtime.mjs");
  const log = path.join(dir, "runtime.log");
  fs.writeFileSync(
    file,
    `#!${process.execPath}
import * as fs from "node:fs";
const first = await new Promise((r) => { let b = ""; process.stdin.on("data", (d) => { b += d; if (b.includes("\\n")) r(b.split("\\n")[0]); }); process.stdin.on("end", () => r(b)); setTimeout(() => r(b), 3000); });
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), first, cwd: process.cwd() }) + "\\n");
const stop = ${JSON.stringify(path.join(dir, "stderr.txt"))};
if (fs.existsSync(stop)) { console.error(fs.readFileSync(stop, "utf8")); process.exit(1); }
process.exit(0);
`,
  );
  fs.chmodSync(file, 0o755);
  return { file, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const hostHooks = () => ({
  beforeFileTool: async () => {},
  mcp: { panel: async () => null },
});

test("a container chat spawns the runtime, passes no host environment, and its initialize declares no host hook", async () => {
  const dir = tmp("spawn-");
  const rt = fakeRuntime(dir);
  const cl = { ...login, runtime: rt.file };
  process.env.GITHUB_TOKEN = "must-not-reach-the-runtime";
  const chat = new core.Chat({ sessionId: NEW, cwd: dir, claudePath: "/nonexistent/claude", existing: false, idleMs: 60000, container: cl, hooks: hostHooks, env: { ...process.env, EMBARCH_DESK_DATA_DIR: "/d" } });
  chat.send("hi");
  await waitFor(() => rt.runs().length > 0);
  const run = rt.runs()[0];
  assert.deepEqual(run.argv.slice(0, 8), ["exec", "-i", "-u", "agent", "-w", "/work/fw", "embarch-agent-fw", "claude"]);
  assert.ok(run.argv.includes("--session-id"));
  for (const k of ["GITHUB_TOKEN", "EMBARCH_DESK_DATA_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"]) assert.ok(!run.env.includes(k), `${k} reached the runtime`);
  const init = JSON.parse(run.first);
  assert.equal(init.request.subtype, "initialize");
  assert.ok(!("hooks" in init.request), "no hook is declared");
  assert.deepEqual(init.request.sdkMcpServers, ["panel"]);
  chat.dispose?.();
  delete process.env.GITHUB_TOKEN;
});

test("a host chat's initialize still declares the autosave hook", async () => {
  const init = core.initializeRequest(hostHooks());
  assert.ok(init.hooks);
});

test("an exec that finds the container stopped says to run `embarch agent up`", async () => {
  const dir = tmp("down-");
  const rt = fakeRuntime(dir);
  fs.writeFileSync(path.join(dir, "stderr.txt"), "Error response from daemon: container abc is not running");
  const cl = { ...login, runtime: rt.file };
  const chat = new core.Chat({ sessionId: NEW, cwd: dir, claudePath: "x", existing: false, idleMs: 60000, container: cl, env: { PATH: process.env.PATH } });
  const events = [];
  chat.on("event", (e) => events.push(e));
  chat.send("hi");
  await waitFor(() => events.some((e) => e.type === "_process" && e.state === "error"));
  const err = events.find((e) => e.type === "_process" && e.state === "error");
  assert.match(err.error, /embarch agent up/);
  assert.match(err.error, /embarch-agent-fw/);
  assert.equal(core.containerDownLine(login, "some other failure"), null);
});

test("a handoff from a container chat starts a container chat; one from a host chat starts a host chat", async () => {
  const dir = tmp("handoff-");
  const rt = fakeRuntime(dir);
  const cl = { ...login, runtime: rt.file };
  const stateFile = path.join(dir, "logins.json");
  const logins = { work: {}, box: { container: { record: "/unused" } } };
  const containerFor = (sid, from) => core.loginContainer(logins[core.resolveChatLogin(stateFile, sid, from, "box", logins, false)], () => cl);
  const settings = {
    claudePath: "/bin/false",
    idleMs: 60000,
    log: () => {},
    env: (sid, from, keep) => ({ PATH: process.env.PATH, L: core.resolveChatLogin(stateFile, sid, from, "box", logins, keep) }),
    container: containerFor,
  };
  const manager = new core.ChatManager(() => settings);
  const old = manager.create(OLD, dir, null, null, {});
  assert.equal(old.chat.opts.container?.container, "embarch-agent-fw");
  // What the extension's handoff does: the fresh chat names the old one as the chat whose login it keeps (106).
  const fresh = manager.create(NEW, dir, null, null, { loginFrom: OLD });
  assert.equal(fresh.chat.opts.container?.container, "embarch-agent-fw");
  fresh.chat.send("carry on");
  await waitFor(() => rt.runs().length > 0);
  assert.deepEqual(rt.runs()[0].argv.slice(0, 8), ["exec", "-i", "-u", "agent", "-w", "/work/fw", "embarch-agent-fw", "claude"]);

  // A host chat's handoff stays on the host.
  const hostSid = "33333333-3333-4333-8333-333333333333";
  const hostState = path.join(dir, "host-logins.json");
  const hostFor = (sid, from) => core.loginContainer(logins[core.resolveChatLogin(hostState, sid, from, "work", logins, false)], () => cl);
  const hostManager = new core.ChatManager(() => ({ ...settings, env: (sid, from, keep) => ({ PATH: process.env.PATH, L: core.resolveChatLogin(hostState, sid, from, "work", logins, keep) }), container: hostFor }));
  const h1 = hostManager.create(hostSid, dir, null, null, {});
  const h2 = hostManager.create("44444444-4444-4444-8444-444444444444", dir, null, null, { loginFrom: hostSid });
  assert.equal(h1.chat.opts.container, undefined);
  assert.equal(h2.chat.opts.container, undefined);
});

test("a container login whose record cannot be read refuses, and never runs on the host", () => {
  assert.throws(() => core.readContainerLogin({ record: path.join(ROOT, "missing.toml") }), /cannot read/);
  const manager = new core.ChatManager(() => ({
    claudePath: "/bin/false",
    idleMs: 60000,
    log: () => {},
    container: () => {
      throw new Error("container login: cannot read");
    },
  }));
  assert.throws(() => manager.create(NEW, ROOT, null, null, {}), /cannot read/);
});

test("last_session for a container login reads the exchange folder's transcripts, named for the container's working path", () => {
  const exchange = tmp("exchange-");
  const cl = { ...login, exchange };
  const chat = new core.Chat({ sessionId: NEW, cwd: "/host/fw", claudePath: "x", existing: true, idleMs: 60000, container: cl });
  const root = path.join(exchange, "claude-config", "projects");
  assert.equal(chat.projectsRoot, root);
  assert.equal(chat.transcriptCwd, "/work/fw");
  const dirFor = path.join(root, "-work-fw");
  fs.mkdirSync(dirFor, { recursive: true });
  const f = path.join(dirFor, `${OLD}.jsonl`);
  fs.writeFileSync(f, [JSON.stringify({ type: "user", message: { role: "user", content: "what the container did" } }), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done in the container" }] } })].join("\n") + "\n");
  const t = new Date(Date.now() - 3_600_000);
  fs.utimesSync(f, t, t);
  const out = core.formatLastSession(core.lastSession({ cwd: chat.transcriptCwd, root: chat.projectsRoot, currentSessionId: NEW }));
  assert.match(out, /what the container did/);
  assert.match(out, /done in the container/);
  assert.equal(core.findTranscript(OLD, chat.transcriptCwd, chat.projectsRoot), f);
});

test("a container login declares no autosave hook and no diagnostics tool; the handoff and last_session stay", () => {
  const s = { autosave: true, diagnostics: true, handoff: "card" };
  assert.deepEqual(core.panelParts(s, true), { autosave: false, diagnostics: false, handoff: true });
  assert.deepEqual(core.panelParts(s, false), { autosave: true, diagnostics: true, handoff: true });
  assert.equal(core.panelParts({ ...s, handoff: "off" }, true).handoff, false);
});
