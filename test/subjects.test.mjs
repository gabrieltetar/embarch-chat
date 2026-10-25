// What a step touched (decision 87): the pure subject extraction, without a
// webview — each connector's tools on synthetic inputs and results in the
// shapes the tools answer with, the host check on every URL from outside,
// the desk's index filling what a step lacks, and a folded run's list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
  const filled = subj("Bash", { command: "gh pr view 36" });
  assert.deepEqual([filled.title, filled.url], ["Blink", "https://github.com/owner/repo/pull/36"], "the desk's index fills it");
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

test("ghCall reads only what the command says", () => {
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

test("prRef: by number in a repo; without one, only a number no two repos share", () => {
  const pr = (repo, number) => ({ repo, number, title: "t", state: "open", url: `https://github.com/${repo}/pull/${number}`, keys: [] });
  core.setRefs({ issues: [], prs: [pr("owner/repo", 36), pr("owner/other", 36), pr("owner/repo", 40)] });
  assert.equal(core.prRef(36), null);
  assert.equal(core.prRef(36, "Owner/Other").repo, "owner/other");
  assert.equal(core.prRef(40).repo, "owner/repo");
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

test("embarch-api tools: the study, else the board, linking into embarch-ui", () => {
  const st = subj(`${API}run_study`, { study: {} }, { study_id: "st-42" });
  assert.deepEqual([st.connector, st.label, st.url], ["bench", "study st-42", `${UI}#live-study?study=st-42`]);
  assert.equal(subj(`${API}study_status`, { study_id: "st-42" }).id, "bench:study:st-42", "before its result too");
  const b = subj(`${API}build_and_flash`, { project: "fw" }, { success: true, build: { exit_code: 0, target: { board: "nrf54l15dk", app: "blinky" } } });
  assert.deepEqual([b.label, b.url], ["nrf54l15dk", `${UI}#topology`]);
  assert.equal(subj(`${API}mem_read`, { ranges: ["0x20000000"] }).label, "DUT");
  assert.equal(subj(`${API}reset_dev_bench`, {}).label, "dev bench");
  assert.equal(subj(`${API}set_role_board`, { role: "dut", board: "nrf54l15dk", chip: "nRF54L15" }).label, "nrf54l15dk");
  assert.equal(subj(`${API}declare_signal`, { name: "tx_done" }), null, "a signal's name is no board");
  assert.equal(subj(`${API}list_projects`, {}, "[]"), null);
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
