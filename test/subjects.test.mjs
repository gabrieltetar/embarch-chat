// What a step touched (decision 87): the pure subject extraction, without a
// webview — each connector's tools on synthetic inputs and results in the
// shapes the tools answer with, the host check on every URL from outside,
// the desk's index filling what a step lacks, and a folded run's list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

const DESK = "mcp__plugin_embarch-desk_embarch-desk__";
const API = "mcp__embarch-api__";
const LIN = "mcp__linear-acme__";
const SLACK = "mcp__claude_ai_Slack__";
const UI = "http://127.0.0.1:4890/";
const env = { uiUrl: UI, own: null };
const step = (name, input, result) => ({ name, input, result: result === undefined ? undefined : typeof result === "string" ? result : JSON.stringify(result, null, 2) });
const subj = (name, input, result, e = env) => core.stepSubject(step(name, input, result), e);
const ISSUE = { workspace: "acme", key: "ABC-154", title: "Make the widget blink", url: "https://linear.app/acme/issue/ABC-154/make-the-widget-blink", state: "In Progress" };

test.afterEach(() => core.setRefs(null));

// ------------------------------------------------------------ Linear

test("the desk's linear_get_issue: the key, the title and the issue's Linear link from its result", () => {
  const s = subj(`${DESK}linear_get_issue`, { key: "abc-154" }, ISSUE);
  assert.deepEqual(s, { connector: "linear", label: "ABC-154", title: "Make the widget blink", url: ISSUE.url, where: "Linear", id: "linear:ABC-154" });
});

test("an issue URL from a result is a link only as https on linear.app", () => {
  for (const url of ["https://linear.app.evil.example/x/issue/ABC-154", "http://linear.app/acme/issue/ABC-154", "https://evil.example/ABC-154", "javascript:alert(1)", "https://user@linear.app/acme/issue/ABC-154", "https://linear.app:8443/acme/issue/ABC-154"]) {
    const s = subj(`${DESK}linear_get_issue`, { key: "ABC-154" }, { ...ISSUE, url });
    assert.equal(s.url, undefined, url);
    assert.equal(s.title, "Make the widget blink");
  }
});

test("a step with only the key falls back to it, then takes the title and link from the desk's index, else from the chat's own item", () => {
  const set = (r) => subj(`${DESK}linear_set_status`, { key: "ABC-154", status: "In Review" }, r);
  const bare = set({ key: "ABC-154", state: "In Review" });
  assert.equal(bare.label, "ABC-154");
  assert.equal(bare.title, undefined);
  assert.equal(bare.url, undefined, "never a guessed link");
  core.setRefs({ issues: [{ key: "ABC-154", title: "Make the widget blink", url: ISSUE.url }], prs: [] });
  assert.equal(set({ key: "ABC-154", state: "In Review" }).url, ISSUE.url);
  assert.equal(set().title, "Make the widget blink", "before its result too");
  core.setRefs(null);
  const own = { itemId: "w1", title: "Make the widget blink", issueKey: "ABC-154", issueUrl: ISSUE.url };
  const s = core.stepSubject(step(`${DESK}linear_draft_comment`, { issue_key: "abc-154", body: "x" }, { draft_id: "d3", status: "waiting" }), { uiUrl: UI, own });
  assert.deepEqual([s.label, s.title, s.url], ["ABC-154", "Make the widget blink", ISSUE.url]);
  core.setRefs({ issues: [{ key: "ABC-154", title: "x", url: "https://evil.example/ABC-154" }], prs: [] });
  assert.equal(set().url, undefined, "the index's links pass the same check");
});

test("linear_search: one hit is that issue; several are no one thing, unless the query is a key; a draft issue waits on the Desk", () => {
  assert.equal(subj(`${DESK}linear_search`, { query: "blink" }, { scope: null, issues: [ISSUE] }).url, ISSUE.url);
  assert.equal(subj(`${DESK}linear_search`, { query: "blink" }, { scope: null, issues: [ISSUE, { ...ISSUE, key: "ABC-155" }] }), null);
  assert.equal(subj(`${DESK}linear_search`, { query: "ABC-155" }, { scope: null, issues: [] }).label, "ABC-155");
  assert.equal(subj(`${DESK}linear_my_issues`, {}, { issues: [ISSUE] }), null);
  const d = subj(`${DESK}linear_draft_issue`, { title: "Blink faster", team_key: "ABC" }, { draft_id: "d4" });
  assert.deepEqual([d.connector, d.label, d.title, d.url], ["linear", "New issue", "Blink faster", `${UI}#desk`]);
});

test("a linear-* server: get_issue and save_issue answer with the issue, save_comment names it in its input, an initiative's id is no issue", () => {
  const got = { id: "ABC-154", uuid: "u-1", title: "Make the widget blink", url: ISSUE.url, status: "Todo" };
  assert.deepEqual(subj(`${LIN}get_issue`, { id: "ABC-154" }, got), { connector: "linear", label: "ABC-154", title: "Make the widget blink", url: ISSUE.url, where: "Linear", id: "linear:ABC-154" });
  assert.equal(subj(`${LIN}save_issue`, { team: "ABC", title: "Make the widget blink" }, got).label, "ABC-154", "a new issue is the one its result is");
  const c = subj(`${LIN}save_comment`, { issueId: "ABC-154", body: "x" }, { id: "9f2c0d4e-0000-4000-8000-000000000000", body: "x" });
  assert.deepEqual([c.label, c.url], ["ABC-154", undefined]);
  assert.equal(subj(`${LIN}get_initiative`, { id: "I-12" }, { id: "I-12", name: "Q4" }), null);
  assert.equal(subj("mcp__claude_ai_Linear__get_issue", { id: "ABC-154" }, got).url, ISSUE.url, "the claude.ai connector too");
  assert.equal(subj(`${LIN}list_issues`, { assignee: "me" }, { issues: [got] }), null);
});

// ------------------------------------------------------------ GitHub

const VIEW = "title:\tBlink\nstate:\tOPEN\nauthor:\tsomeone\nlabels:\t\nassignees:\t\nreviewers:\t\nprojects:\t\nmilestone:\t\nnumber:\t36\nurl:\thttps://github.com/owner/repo/pull/36\nadditions:\t3\ndeletions:\t1\nauto-merge:\tdisabled\n--\nFixes https://github.com/owner/repo/pull/99 too.\n";

test("Bash `gh pr view 36`: #36, its title and its URL from gh's piped output", () => {
  const s = subj("Bash", { command: "gh pr view 36", description: "View the PR" }, VIEW);
  assert.deepEqual(s, { connector: "github", label: "#36", title: "Blink", url: "https://github.com/owner/repo/pull/36", where: "GitHub", id: "github:owner/repo#36" });
  const running = subj("Bash", { command: "gh pr view 36" });
  assert.deepEqual([running.label, running.title, running.url], ["#36", undefined, undefined], "while it runs: the number, no guessed repo");
  core.setRefs({ issues: [], prs: [{ repo: "owner/repo", number: 36, title: "Blink", state: "open", url: "https://github.com/owner/repo/pull/36", keys: ["ABC-154"] }] });
  const filled = subj("Bash", { command: "gh pr view 36" }, undefined, { ...env, repo: "owner/repo" });
  assert.deepEqual([filled.title, filled.url], ["Blink", "https://github.com/owner/repo/pull/36"], "run in the chat's folder: its repo's PR, from the desk's index");
  const unknown = subj("Bash", { command: "gh pr view 36" });
  assert.deepEqual([unknown.title, unknown.url], [undefined, undefined], "no repo known: the index's only #36 is not taken for it");
});

test("gh: --json, -R, a URL argument, create's printed URL, merge's flags, gh api, an issue, a URL off github.com", () => {
  const j = subj("Bash", { command: "gh pr view 36 -R owner/repo --json title,url,number,isDraft" }, { title: "Blink", url: "https://github.com/owner/repo/pull/36", number: 36, isDraft: false });
  assert.deepEqual([j.label, j.title, j.url], ["#36", "Blink", "https://github.com/owner/repo/pull/36"]);
  const c = subj("Bash", { command: 'git push -u origin HEAD && gh pr create --title "Blink" --body "a; b && c | d"' }, "https://github.com/owner/repo/pull/37\n");
  assert.deepEqual([c.label, c.url], ["#37", "https://github.com/owner/repo/pull/37"]);
  const m = subj("Bash", { command: "cd /w/x && gh pr merge -m 36 --delete-branch" }, "");
  assert.deepEqual([m.label, m.url], ["#36", undefined]);
  const u = subj("Bash", { command: "gh pr checkout https://github.com/owner/repo/pull/5; gh pr diff https://github.com/owner/repo/pull/36" }, "+ see https://github.com/owner/repo/pull/7");
  assert.deepEqual([u.label, u.url], ["#36", "https://github.com/owner/repo/pull/36"], "the first gh call it knows, its URL from the command");
  const api = subj("Bash", { command: "gh api repos/owner/repo/pulls/36" }, { number: 36, title: "Blink", state: "open", draft: true, html_url: "https://github.com/owner/repo/pull/36", url: "https://api.github.com/repos/owner/repo/pulls/36", head: { ref: "blink" } });
  assert.deepEqual([api.label, api.title, api.url], ["#36", "Blink", "https://github.com/owner/repo/pull/36"]);
  const comments = subj("Bash", { command: "gh api repos/owner/repo/issues/36/comments --paginate" }, "[]");
  assert.equal(comments.url, "https://github.com/owner/repo/issues/36");
  const issue = subj("Bash", { command: "gh issue view 12 --repo owner/repo" }, "title:\tFlaky\nstate:\tOPEN\nnumber:\t12\n--\nbody\n");
  assert.deepEqual([issue.label, issue.title, issue.url], ["#12", "Flaky", "https://github.com/owner/repo/issues/12"]);
  const checks = subj("Bash", { command: "gh pr checks 36" }, "build\tpass\t1m\thttps://github.com/owner/repo/actions/runs/1\n");
  assert.equal(checks.url, undefined, "a check's link is not the PR's");
  const ghe = subj("Bash", { command: "gh pr view 36 -R ghe.example/owner/repo" }, "title:\tBlink\nurl:\thttps://ghe.example/owner/repo/pull/36\n");
  assert.equal(ghe.url, undefined, "only github.com's");
  assert.equal(subj("Bash", { command: "gh pr list" }, "36\tBlink"), null);
  assert.equal(subj("Bash", { command: "git log --oneline" }, "abc"), null);
});

test("gh pr merge|close|ready|review|checks|diff N without -R: the repo gh's line names, else the chat's folder's — never the index's only #N (decision 87)", () => {
  const other = { repo: "owner/other", number: 36, title: "Another repo's PR", state: "open", url: "https://github.com/owner/other/pull/36", keys: [] };
  const mine = { repo: "owner/repo", number: 36, title: "Blink", state: "open", url: "https://github.com/owner/repo/pull/36", keys: [] };
  core.setRefs({ issues: [], prs: [other] });
  const at = (repo) => ({ ...env, repo });
  const shown = (s) => [s.label, s.title, s.url, s.id];
  // Unique in the desk's index is not the cwd's PR: with no repo known, #36 alone, untitled and unlinked.
  for (const cmd of ["gh pr merge 36 --squash", "gh pr close 36", "gh pr ready 36", "gh pr review 36 --approve", "gh pr checks 36", "gh pr diff 36"]) {
    assert.deepEqual(shown(subj("Bash", { command: cmd }, "")), ["#36", undefined, undefined, "github:#36"], cmd);
  }
  // In a folder whose remote is owner/repo: that repo's #36, its title from the index when it has it.
  assert.deepEqual(shown(subj("Bash", { command: "gh pr checks 36" }, "build\tpass\t1m\thttps://github.com/owner/other/actions/runs/1\n", at("owner/repo"))), [
    "#36",
    undefined,
    "https://github.com/owner/repo/pull/36",
    "github:owner/repo#36",
  ]);
  core.setRefs({ issues: [], prs: [other, mine] });
  assert.deepEqual(shown(subj("Bash", { command: "gh pr diff 36" }, "+x", at("owner/repo"))), ["#36", "Blink", "https://github.com/owner/repo/pull/36", "github:owner/repo#36"]);
  // gh's own line names the repo, and the title: it wins over the folder's.
  const merged = subj("Bash", { command: "gh pr merge 36 --squash --delete-branch" }, "✓ Squashed and merged pull request owner/other#36 (Another repo's PR (v2))\n✓ Deleted local branch x\n", at("owner/repo"));
  assert.deepEqual(shown(merged), ["#36", "Another repo's PR (v2)", "https://github.com/owner/other/pull/36", "github:owner/other#36"]);
  const lines = [
    ["gh pr close 36", "✓ Closed pull request owner/other#36 (Another repo's PR)\n"],
    ["gh pr reopen 36", "✓ Reopened pull request owner/other#36 (Another repo's PR)\n"],
    ["gh pr ready 36", '✓ Pull request owner/other#36 is marked as "ready for review"\n'],
    ["gh pr review 36 --approve", "✓ Approved pull request owner/other#36\n"],
    ["gh pr review 36 -r -b no", "+ Requested changes to pull request owner/other#36\n"],
    ["gh pr merge 36", "! Pull request owner/other#36 was already merged\n"],
  ];
  for (const [cmd, out] of lines) {
    const s = subj("Bash", { command: cmd }, out);
    assert.deepEqual([s.url, s.title], ["https://github.com/owner/other/pull/36", "Another repo's PR"], cmd);
  }
  // No number: gh's own first status line, never what a later command in the line prints — a PR's body or comments
  // that name another (87).
  const view12 = "title:\tGadget\nnumber:\t12\n--\nFollows up pull request other/x#99 (Old)\n✓ Merged pull request other/x#98 (Older)\n";
  for (const out of [
    `✓ Squashed and merged pull request owner/repo#36 (Blink)\n✓ Deleted local branch x\n${view12}`,
    `${view12.replace(/✓ .*\n/, "")}\x1b[0;35m✓\x1b[0m Squashed and merged pull request owner/repo#36 (Blink)\n`,
  ]) {
    const s = subj("Bash", { command: "gh pr merge --squash && gh pr view 12 --comments" }, out, at("owner/other"));
    assert.deepEqual(shown(s), ["#36", "Blink", "https://github.com/owner/repo/pull/36", "github:owner/repo#36"], out);
  }
  assert.equal(subj("Bash", { command: "gh pr merge --squash; gh pr view 12" }, view12.replace(/✓ .*\n/, "")), null, "no status line of gh's: no number known");
  const closed = subj("Bash", { command: "gh issue close 12" }, "✓ Closed issue owner/repo#12 (Flaky)\n");
  assert.deepEqual([closed.label, closed.title, closed.url], ["#12", "Flaky", "https://github.com/owner/repo/issues/12"]);
  // A line about another number is not this one's.
  assert.equal(subj("Bash", { command: "gh pr close 36" }, "✓ Closed pull request owner/other#35 (x)\n").url, undefined);
  // `cd` elsewhere first: the folder's repo is not where it ran.
  assert.equal(subj("Bash", { command: "cd ../other && gh pr merge 36" }, "", at("owner/repo")).url, undefined);
  // GH_REPO, on the command or exported before it, names the repo as -R does.
  assert.equal(subj("Bash", { command: "GH_REPO=owner/other gh pr merge 36" }, "", at("owner/repo")).url, "https://github.com/owner/other/pull/36");
  assert.equal(subj("Bash", { command: "export GH_REPO=owner/other; gh pr view 36" }, undefined, at("owner/repo")).url, "https://github.com/owner/other/pull/36");
  assert.equal(subj("Bash", { command: "GH_REPO=ghe.example/owner/other gh pr merge 36" }, "").url, undefined, "another host's");
});

test("where a command line leaves Claude Code's shell: away after a cd, pushd or popd in the shell itself, home after a cd to the folder by its path (87)", () => {
  const HOME = "/work/rec/x";
  const away = ["cd ../other-clone && git pull", "cd /tmp", "pushd ../other", "popd", "cd", "cd -", "cd .", "cd src", "cd /work/rec/x/src", "if true; then cd /tmp; fi", "FOO=1 cd /tmp", "builtin cd /tmp", "{ cd /tmp; }", "cd /work/rec/x && cd sub", "cd $(git rev-parse --show-toplevel)", "cd ~/x"];
  for (const c of away) assert.equal(core.shellMove(c, HOME), "away", c);
  const home = ["cd /work/rec/x", "cd /work/rec/x/", 'cd "/work/rec/x" && npm test', "cd -- /work/rec/x", "cd -P /work/rec/x", "cd ../other; cd /work/rec/x"];
  for (const c of home) assert.equal(core.shellMove(c, HOME), "home", c);
  // A subshell's cd moves nothing after it; nor does a cd that is a word of another command, or quoted.
  const none = ["(cd ../other && git pull)", "x=$(cd ../other && pwd)", "echo `cd /tmp; pwd`", "git -C ../other pull", 'git commit -m "cd ../x"', "bash -c 'cd /tmp'", "echo cd /tmp", "make -C sub", "'cd' /tmp", "gh pr merge 36"];
  for (const c of none) assert.equal(core.shellMove(c, HOME), null, c);
  assert.equal(core.shellMove("cd /work/rec/x"), "away", "no folder known: no way back is certain");
});

test("a `cd` in an earlier step moves every later step's gh: a gh naming no repo after it is not the chat's folder's repo's, until a step cds back (87)", () => {
  const HOME = "/work/rec/x";
  let n = 0;
  const bash = (command, over = {}) => ({ kind: "tool", id: `b${++n}`, name: "Bash", input: { command }, parent: null, status: "done", result: "", children: [], ...over });
  /** A chat as the reducer keeps it: top-level steps in order, a subagent's under its call. */
  const chat = (...steps) => {
    const entries = {};
    const add = (e) => {
      entries[e.id] = e;
      for (const c of e.kids ?? []) add(c);
    };
    steps.forEach(add);
    for (const e of Object.values(entries)) if (e.kids) e.children = e.kids.map((c) => c.id);
    return { timeline: steps.map((e) => e.id), entries };
  };
  const urls = (c, home = HOME) => {
    const away = core.awaySteps(c.timeline, c.entries, home);
    const e = { ...env, repo: "owner/repo", away };
    return Object.values(c.entries)
      .filter((x) => x.name === "Bash")
      .map((x) => core.stepSubject(x, e)?.url ?? null);
  };
  const PR = "https://github.com/owner/repo/pull/36";
  // The repro: an earlier step cd'd to another clone; the merge names no repo and gh says nothing.
  assert.deepEqual(urls(chat(bash("cd ../other-clone && git pull"), bash("gh pr merge 36 --squash"))), [null, null]);
  // A cd in a subshell, git -C, or none at all: the folder's repo.
  assert.deepEqual(urls(chat(bash("(cd ../other-clone && git pull)"), bash("git -C ../other-clone pull"), bash("gh pr merge 36 --squash"))), [null, null, PR]);
  // Back to the folder by its path: the folder's again; no folder known, not.
  const back = chat(bash("cd ../other-clone && git pull"), bash("gh pr view 36"), bash("cd /work/rec/x && npm test"), bash("gh pr merge 36"));
  assert.deepEqual(urls(back), [null, null, null, PR]);
  assert.deepEqual(urls(back, null), [null, null, null, null]);
  // A repo the command or gh's own line names is that one, wherever the shell is.
  assert.deepEqual(urls(chat(bash("cd ../other-clone"), bash("gh pr merge 36 -R owner/repo"), bash("gh pr merge 37", { result: "✓ Merged pull request owner/other#37 (x)\n" }))), [
    null,
    PR,
    "https://github.com/owner/other/pull/37",
  ]);
  // A step the owner denied never ran.
  assert.deepEqual(urls(chat(bash("cd ../other-clone", { status: "denied" }), bash("gh pr merge 36"))), [null, PR]);
  // A subagent's shell goes back after each of its steps: its cd moves nothing after it; its gh takes the chat's shell as it was.
  const task = (kids) => ({ kind: "tool", id: `a${++n}`, name: "Agent", input: { prompt: "x" }, parent: null, status: "done", result: "", children: [], kids });
  const sub = (command) => bash(command, { parent: "a" });
  assert.deepEqual(urls(chat(task([sub("cd ../other-clone")]), bash("gh pr merge 36"))), [null, PR]);
  assert.deepEqual(urls(chat(bash("cd ../other-clone"), task([sub("gh pr merge 36")]))), [null, null]);
});

test("the chat's folder's GitHub repo: from its git config, github.com only, picked as gh picks it with no terminal; a worktree reads its main checkout's", () => {
  assert.equal(core.githubRepoOfUrl("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(core.githubRepoOfUrl("https://github.com/owner/repo"), "owner/repo");
  assert.equal(core.githubRepoOfUrl("https://x-access-token:t@github.com/owner/repo.git/"), "owner/repo");
  assert.equal(core.githubRepoOfUrl("ssh://git@github.com/owner/repo.git"), "owner/repo");
  for (const u of ["git@ghe.example:owner/repo.git", "https://github.com.evil.example/owner/repo", "https://gitlab.com/owner/repo", "/srv/git/repo.git", "https://github.com/owner"]) {
    assert.equal(core.githubRepoOfUrl(u), null, u);
  }
  const conf = (remotes) => remotes.map(([name, url, extra = ""]) => `[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n${extra}`).join("");
  const pick = (remotes) => core.pickGithubRepo(core.parseRemotes(`[core]\n\tbare = false\n${conf(remotes)}[branch "main"]\n\tremote = origin\n`));
  assert.equal(pick([["origin", "git@github.com:owner/repo.git"]]), "owner/repo");
  assert.equal(pick([["origin", "git@github.com:me/repo.git"], ["upstream", "https://github.com/owner/repo.git"]]), "owner/repo", "upstream before origin, as gh");
  assert.equal(pick([["origin", "git@github.com:me/repo.git"], ["upstream", "https://github.com/owner/repo.git"]].map((r, i) => (i ? r : [...r, "\tgh-resolved = base\n"]))), "me/repo", "gh repo set-default's choice first");
  assert.equal(pick([["origin", "git@ghe.example:owner/repo.git"]]), null, "another host's only");
  assert.equal(pick([]), null);
  // On disk: a checkout, and a worktree whose .git file points into it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-ghrepo-"));
  try {
    const main = path.join(root, "main");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fs.mkdirSync(path.join(main, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "config"), conf([["origin", "git@github.com:owner/repo.git"]]));
    fs.writeFileSync(path.join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    assert.equal(core.githubRepo(path.join(main, "src", "deep")), "owner/repo");
    assert.equal(core.githubRepo(wt), "owner/repo");
    const none = path.join(root, "none");
    fs.mkdirSync(path.join(none, ".git"), { recursive: true });
    fs.writeFileSync(path.join(none, ".git", "config"), "[core]\n\tbare = false\n");
    assert.equal(core.githubRepo(none), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the chat's folder's GitHub repo never hangs the extension host: a FIFO or a device where a git file should be is none, and no read takes more than 64 KB (87)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-ghfifo-"));
  const conf = "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:owner/repo.git\n";
  try {
    const fifo = (p) => execFileSync("mkfifo", [p]);
    // .git/config a FIFO; a worktree's .git file pointing at a git dir whose commondir is one; a .git file that is one.
    const a = path.join(root, "a");
    fs.mkdirSync(path.join(a, ".git"), { recursive: true });
    fifo(path.join(a, ".git", "config"));
    const main = path.join(root, "main");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "config"), conf);
    fifo(path.join(main, ".git", "worktrees", "wt", "commondir"));
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    const c = path.join(root, "c");
    fs.mkdirSync(c);
    fifo(path.join(c, ".git"));
    const dev = path.join(root, "dev");
    fs.mkdirSync(path.join(dev, ".git"), { recursive: true });
    fs.symlinkSync("/dev/zero", path.join(dev, ".git", "config"));
    // A config past 64 KB: what fits is read, a line cut short is not.
    const big = path.join(root, "big");
    fs.mkdirSync(path.join(big, ".git"), { recursive: true });
    fs.writeFileSync(path.join(big, ".git", "config"), `${conf}${"# filler line\n".repeat(6000)}[remote "upstream"]\n\turl = git@github.com:other/repo.git\n`);
    // In a child, so a read that blocks fails the test instead of hanging the run.
    const probe = `const core = require(${JSON.stringify(path.resolve("test-out/core.js"))}); process.stdout.write(JSON.stringify(${JSON.stringify([a, wt, c, big, dev])}.map((d) => core.githubRepo(d))));`;
    const r = spawnSync(process.execPath, ["-e", probe], { timeout: 5000, encoding: "utf8" });
    assert.equal(r.signal, null, "githubRepo returned instead of blocking on a FIFO");
    // A FIFO commondir: the worktree's own git dir has no config, so no repo — never a hang.
    assert.deepEqual(JSON.parse(r.stdout), [null, null, null, "owner/repo", null]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ghCall reads only what the command says: a gh in a command's place, never one inside quotes or as an argument", () => {
  assert.equal(core.ghCall('git commit -m "follow-up to gh pr view 3"'), null);
  assert.equal(core.ghCall("git commit -m 'gh pr merge 3'"), null);
  assert.equal(core.ghCall('git commit -m "a \\"quoted\\" gh pr view 3" && echo gh pr view 4'), null);
  assert.deepEqual(core.ghCall('git commit -m "follow-up to gh pr view 3" && gh pr view 4'), { kind: "pr", action: "view", number: 4 });
  assert.deepEqual(core.ghCall("if true; then gh pr view 5; fi"), { kind: "pr", action: "view", number: 5 });
  assert.deepEqual(core.ghCall("t=$(gh pr view 6 --json title)"), { kind: "pr", action: "view", number: 6 });
  assert.deepEqual(core.ghCall("(gh pr view 7)"), { kind: "pr", action: "view", number: 7 });
  assert.deepEqual(core.ghCall("cd /w/x && gh pr merge 8"), { kind: "pr", action: "merge", number: 8, moved: true });
  // -i takes a value, as --interval does.
  assert.deepEqual(core.ghCall("gh pr checks --watch -i 10 36"), { kind: "pr", action: "checks", number: 36 });
  assert.deepEqual(core.ghCall("gh pr checks --watch --interval 10 36"), { kind: "pr", action: "checks", number: 36 });
  assert.deepEqual(core.ghCall("gh pr view 36"), { kind: "pr", action: "view", number: 36 });
  assert.deepEqual(core.ghCall("gh pr comment --body 12 36 --repo=owner/repo"), { kind: "pr", action: "comment", number: 36, repo: "owner/repo" });
  assert.deepEqual(core.ghCall("gh pr view --json title"), { kind: "pr", action: "view" });
  assert.deepEqual(core.ghCall("gh issue close #12 -R owner/repo"), { kind: "issue", action: "close", number: 12, repo: "owner/repo" });
  assert.deepEqual(core.ghCall("gh api -X PATCH /repos/owner/repo/pulls/36 -f title=x"), { kind: "pr", action: "api", repo: "owner/repo", number: 36 });
  assert.equal(core.ghCall("echo nothing to see"), null);
  assert.equal(core.ghCall("sigh pr view 36"), null);
});

test("WebFetch on a GitHub PR or a Linear issue page", () => {
  const g = subj("WebFetch", { url: "https://github.com/owner/repo/pull/36/files", prompt: "x" }, "a summary");
  assert.deepEqual([g.connector, g.label, g.url], ["github", "#36", "https://github.com/owner/repo/pull/36"]);
  const l = subj("WebFetch", { url: ISSUE.url, prompt: "x" });
  assert.deepEqual([l.connector, l.label, l.url], ["linear", "ABC-154", ISSUE.url]);
  assert.equal(subj("WebFetch", { url: "https://example.com/owner/repo/pull/36" }), null);
});

test("prRef: by number in its repo, never by the number alone", () => {
  const pr = (repo, number) => ({ repo, number, title: "t", state: "open", url: `https://github.com/${repo}/pull/${number}`, keys: [] });
  core.setRefs({ issues: [], prs: [pr("owner/repo", 36), pr("owner/other", 36), pr("owner/repo", 40)] });
  assert.equal(core.prRef(36, "Owner/Other").repo, "owner/other");
  assert.equal(core.prRef(40, "owner/repo").repo, "owner/repo");
  assert.equal(core.prRef(40, "owner/other"), null, "the only #40 is another repo's");
  assert.equal(core.issueRef("abc-1"), null);
});

// ------------------------------------------------------------ Slack

test("Slack: the channel by name with Slack's link to it, a sent message's permalink, a search is no one thing", () => {
  const read = subj(`${SLACK}slack_read_channel`, { channel_id: "C0123ABCD" }, { messages: "Channel: general (C0123ABCD)\n\n=== Message from someone ===\nhi", pagination_info: "" });
  assert.deepEqual([read.label, read.url], ["#general", "https://slack.com/app_redirect?channel=C0123ABCD"]);
  const sent = subj(`${SLACK}slack_send_message`, { channel_id: "C0123ABCD", message: "hi" }, "Message sent. Permalink: https://acme.slack.com/archives/C0123ABCD/p1729850000123456");
  assert.deepEqual([sent.label, sent.url], ["#C0123ABCD", "https://acme.slack.com/archives/C0123ABCD/p1729850000123456"]);
  const evil = subj(`${SLACK}slack_send_message`, { channel_id: "C0123ABCD", message: "hi" }, "Permalink: https://acme.slack.com.evil.example/archives/C0123ABCD/p1");
  assert.equal(evil.url, "https://slack.com/app_redirect?channel=C0123ABCD", "an off-host permalink is dropped");
  const draft = subj(`${SLACK}slack_send_message_draft`, { channel_id: "C0123ABCD", message: "hi" }, { channel_link: "https://app.slack.com/client/T01/C0123ABCD" });
  assert.equal(draft.url, "https://app.slack.com/client/T01/C0123ABCD");
  assert.equal(subj(`${SLACK}slack_send_message`, { channel_id: "U0123ABCD", message: "hi" }, "ok").label, "DM");
  const thread = (messages) => subj(`${SLACK}slack_read_thread`, { channel_id: "C0123ABCD", message_ts: "1729850000.123456" }, { messages });
  assert.equal(thread("Channel: general (C0123ABCD)\nPermalink: https://acme.slack.com/archives/C0123ABCD/p1729850000123456\n").url, "https://acme.slack.com/archives/C0123ABCD/p1729850000123456", "the thread's own permalink");
  assert.equal(thread("Channel: general (C0123ABCD)\nPermalink: https://acme.slack.com/archives/C0123ABCD/p1729859999000001\n").url, "https://slack.com/app_redirect?channel=C0123ABCD", "a reply's permalink is not the thread's");
  assert.equal(subj(`${SLACK}slack_search_public`, { keywords: ["blink"] }, { results: "Permalink: [link](https://acme.slack.com/archives/C1/p1)" }), null);
});

// ------------------------------------------------------------ the Desk and the bench

test("desk_* tools: the work item by its name, linking to its card on the Desk", () => {
  const set = subj(`${DESK}desk_set_work_item`, { session_id: "s", issue_key: "ABC-154" }, { item_id: "w12", title: "Make the widget blink" });
  assert.deepEqual(set, { connector: "desk", label: "Make the widget blink", url: `${UI}#desk?item=w12`, where: "the Desk", id: "desk:w12" });
  assert.equal(subj(`${DESK}desk_set_work_item`, { session_id: "s", untracked: true }, { untracked: true }), null);
  assert.equal(subj(`${DESK}desk_create_item`, { title: "Bench call" }, { id: "w13" }).label, "Bench call");
  const brief = "Work item w12: ABC-154 Make the widget blink — In Progress (https://linear.app/acme/issue/ABC-154)\nrepo /w/x\n\n## Issue\n...";
  assert.deepEqual([subj(`${DESK}desk_work_item`, { session_id: "s" }, brief).label, subj(`${DESK}desk_work_item`, { session_id: "s" }, brief).url], ["Make the widget blink", `${UI}#desk?item=w12`]);
  assert.equal(subj(`${DESK}desk_work_item`, { session_id: "s" }, "Work item w14: Support call (no Linear issue)\n").label, "Support call");
  const own = { itemId: "w12", title: "Make the widget blink" };
  const line = core.stepSubject(step(`${DESK}desk_add_line`, { session_id: "s", text: "done" }, { tile: "w12@2026-10-25", note_id: "n1" }), { uiUrl: UI, own });
  assert.deepEqual([line.label, line.url], ["Make the widget blink", `${UI}#desk?item=w12`]);
  assert.equal(subj(`${DESK}desk_whoami`, { session_id: "s" }, { work_item: { id: "w12", title: "Make the widget blink" } }).id, "desk:w12");
  assert.equal(subj(`${DESK}desk_list_items`, {}, { items: [] }), null);
  assert.equal(subj(`${DESK}harvest_entries`, {}, {}), null);
  assert.equal(core.stepSubject(step(`${DESK}desk_set_work_item`, {}, { item_id: "w12", title: "x" }), { uiUrl: "", own: null }).url, undefined, "no UI address, no link");
});

test("embarch-api tools: the study, else the board, linking into embarch-ui — a board by its role where the step named one, else by its board type (embarch-ui decision 58)", () => {
  const st = subj(`${API}run_study`, { study: {} }, { study_id: "st-42" });
  assert.deepEqual([st.connector, st.label, st.url], ["bench", "study st-42", `${UI}#live-study?study=st-42`]);
  assert.equal(subj(`${API}study_status`, { study_id: "st-42" }).id, "bench:study:st-42", "before its result too");
  const b = subj(`${API}build_and_flash`, { project: "fw" }, { success: true, build: { exit_code: 0, target: { board: "nrf54l15dk", app: "blinky" } } });
  assert.deepEqual([b.label, b.url], ["nrf54l15dk", `${UI}#topology?board=nrf54l15dk`]);
  assert.equal(subj(`${API}build`, { board: "nrf54l15dk/nrf54l15/cpuapp" }).url, `${UI}#topology?board=nrf54l15dk%2Fnrf54l15%2Fcpuapp`, "encoded");
  const mem = subj(`${API}mem_read`, { ranges: ["0x20000000"] });
  assert.deepEqual([mem.label, mem.url], ["DUT", `${UI}#topology?board=dut`]);
  const bench = subj(`${API}reset_dev_bench`, {});
  assert.deepEqual([bench.label, bench.url], ["dev bench", `${UI}#topology?board=dev-bench`]);
  const set = subj(`${API}set_role_board`, { role: "dut", board: "nrf54l15dk", chip: "nRF54L15" });
  assert.deepEqual([set.label, set.url], ["nrf54l15dk", `${UI}#topology?board=dut`]);
  assert.equal(subj(`${API}declare_signal`, { name: "tx_done" }), null, "a signal's name is no board");
  assert.equal(subj(`${API}list_projects`, {}, "[]"), null);
});

test("what a step touched is read once per step entry, and again when the desk's index or the env changes", () => {
  const t = step(`${DESK}linear_get_issue`, { key: "ABC-154" }, { key: "ABC-154" });
  const a = core.stepSubject(t, env);
  assert.equal(core.stepSubject(t, { ...env }), a, "the same entry and env: the same answer, not read again");
  assert.equal(a.title, undefined);
  core.setRefs({ issues: [{ key: "ABC-154", title: "Make the widget blink", url: ISSUE.url }], prs: [] });
  const b = core.stepSubject(t, env);
  assert.notEqual(b, a);
  assert.equal(b.title, "Make the widget blink", "a new index is read");
  const c = core.stepSubject(t, { ...env, uiUrl: "http://127.0.0.1:4999/" });
  assert.notEqual(c, b, "another env is read");
  const g = step("Bash", { command: "gh pr merge 36" }, "");
  assert.equal(core.stepSubject(g, env).url, undefined);
  assert.equal(core.stepSubject(g, { ...env, repo: "owner/repo" }).url, "https://github.com/owner/repo/pull/36", "the chat's repo is part of the env");
  // So is whether an earlier step took the shell elsewhere, step by step.
  const h = { ...g, id: "b9" };
  assert.equal(core.stepSubject(h, { ...env, repo: "owner/repo", away: new Set(["b9"]) }).url, undefined, "this step is away");
  assert.equal(core.stepSubject(h, { ...env, repo: "owner/repo", away: new Set(["b8"]) }).url, "https://github.com/owner/repo/pull/36", "another is");
});

test("a tool that touches no connector names nothing", () => {
  for (const [name, input] of [["Read", { file_path: "/w/x" }], ["Grep", { pattern: "ABC-154" }], ["mcp__other__get_issue", { id: "ABC-154" }]]) assert.equal(subj(name, input), null, name);
});

// ------------------------------------------------------------ a folded run

test("a run lists what its steps touched: each thing once, at most 3, then +N; its head names its own", () => {
  const tool = (id, name, input, result) => ({ kind: "tool", id, name, input, result: typeof result === "string" ? result : JSON.stringify(result), parent: null, status: "done", children: [] });
  const steps = [
    tool("a", `${DESK}linear_set_status`, { key: "ABC-154", status: "In Review" }, { key: "ABC-154", state: "In Review" }),
    { kind: "thinking", id: "t", text: "hm", parent: null },
    tool("b", "Bash", { command: "gh pr view 36" }, VIEW),
    tool("c", `${DESK}linear_get_issue`, { key: "ABC-154" }, ISSUE),
    tool("d", "Read", { file_path: "/w/x" }, "x"),
    tool("e", `${SLACK}slack_read_channel`, { channel_id: "C0123ABCD" }, { messages: "Channel: general (C0123ABCD)\n" }),
    tool("f", `${API}run_study`, { study: {} }, { study_id: "st-42" }),
    tool("g", "Bash", { command: "gh pr view 36 --json title" }, { title: "Blink" }),
    tool("h", `${DESK}desk_set_work_item`, { session_id: "s" }, { item_id: "w12", title: "Make the widget blink" }),
  ];
  const r = core.runSubjects(steps, env);
  assert.deepEqual(
    r.shown.map((s) => s.id),
    ["linear:ABC-154", "github:owner/repo#36", "slack:C0123ABCD"],
  );
  assert.equal(r.more, 1, "the study; #36 named without its repo is the same #36; the head's card is on the head's line");
  // The second sighting of ABC-154 knew its title and link: the entry has them, at the first one's place.
  assert.deepEqual([r.shown[0].title, r.shown[0].url], ["Make the widget blink", ISSUE.url]);
  assert.deepEqual(core.runSubjects(steps.slice(0, 2), env), { shown: [], more: 0 }, "a run of one thing is its head's");
  assert.deepEqual(core.runSubjects(steps, env, 10).shown.map((s) => s.label), ["ABC-154", "#36", "#general", "study st-42"]);
});
