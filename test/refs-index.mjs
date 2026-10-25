// A made-up desk reference index (GET /refs, embarch-desk decision 56) for
// the tests and the cards-refs recording (decision 88): neutral keys, repos
// and titles — never the owner's. The case it is built around: a chat on
// one item whose draft says "just like the widget PR did", where the desk
// knows that PR and the Done issue it closed.

export const ISSUES = [
  { key: "ABC-171", title: "Make the gadget parser stream", state: "In Progress", url: "https://linear.app/acme/issue/ABC-171/make-the-gadget-parser-stream" },
  { key: "ABC-170", title: "Add the gadget parser", state: "In Progress", url: "https://linear.app/acme/issue/ABC-170/add-the-gadget-parser" },
  { key: "ABC-162", title: "Flash the dev board from CI", state: "Done", url: "https://linear.app/acme/issue/ABC-162/flash-the-dev-board-from-ci" },
  { key: "ABC-160", title: "Add a test for the UART ring buffer", state: "In Progress", url: "https://linear.app/acme/issue/ABC-160/add-a-test-for-the-uart-ring-buffer" },
  { key: "ABC-158", title: "Tests for the sensor driver", state: "Canceled", url: "https://linear.app/acme/issue/ABC-158/tests-for-the-sensor-driver" },
  { key: "ABC-154", title: "Create the Widget", state: "Done", url: "https://linear.app/acme/issue/ABC-154/create-the-widget" },
  { key: "ABC-150", title: "Document the release process", state: "Done", url: "https://linear.app/acme/issue/ABC-150/document-the-release-process" },
];

const pr = (repo, number, title, state, branch, keys, draft = false) => ({ repo, number, title, state, draft, url: `https://github.com/${repo}/pull/${number}`, branch, keys });

export const PRS = [
  pr("owner/repo", 44, "Gadget parser", "open", "abc-170-add-the-gadget-parser", ["ABC-170"], true),
  pr("owner/repo", 40, "UART ring buffer test", "open", "abc-160-uart-test", ["ABC-160"]),
  pr("owner/repo", 38, "Flash from CI", "merged", "abc-162-flash-ci", ["ABC-162"]),
  pr("owner/repo", 36, "Widget", "merged", "abc-154-create-the-widget", ["ABC-154"]),
  pr("owner/docs", 36, "Release notes template", "merged", "release-notes", []),
  pr("owner/docs", 12, "Document the release process", "merged", "abc-150-release", ["ABC-150"]),
];

export const INDEX = { desk_id: "k1", synced_ms: 1_000, issues: ISSUES, prs: PRS };

/** The chat's own item in the recorded case: the gadget parser, its own draft PR on its card. */
export const OWN = { key: "ABC-170", title: "Add the gadget parser", state: "In Progress", prs: [{ repo: "owner/repo", number: 44 }] };

/** The draft, as the owner wrote his own: a vague pointer at another item's PR. */
export const VAGUE = "Let's include a test just like the widget PR did, with the same structure";
