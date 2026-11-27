// The desk's own rule for where it is, read from an environment (decision 124).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

test("the config folder follows the desk's precedence", () => {
  assert.equal(core.deskConfigDir({ EMBARCH_DESK_CONFIG_DIR: "/s/c", XDG_CONFIG_HOME: "/x", HOME: "/h" }), "/s/c");
  assert.equal(core.deskConfigDir({ XDG_CONFIG_HOME: "/x", HOME: "/h" }), "/x/embarch-desk");
  assert.equal(core.deskConfigDir({ HOME: "/h" }), "/h/.config/embarch-desk");
});

test("an empty XDG_CONFIG_HOME counts as unset", () => {
  assert.equal(core.deskConfigDir({ XDG_CONFIG_HOME: "", HOME: "/h" }), "/h/.config/embarch-desk");
});

test("the token is desk-token in that folder", () => {
  assert.equal(core.deskTokenFile({ EMBARCH_DESK_CONFIG_DIR: "/s/c" }), "/s/c/desk-token");
  assert.equal(core.deskTokenFile({ HOME: "/h" }), "/h/.config/embarch-desk/desk-token");
});

test("the port is EMBARCH_DESK_PORT when it parses, else 4891", () => {
  assert.equal(core.deskBaseUrl({}), "http://127.0.0.1:4891");
  assert.equal(core.deskBaseUrl({ EMBARCH_DESK_PORT: "4892" }), "http://127.0.0.1:4892");
  for (const bad of ["", "abc", "70000", "-1", "48 92", "4892x"]) assert.equal(core.deskPort({ EMBARCH_DESK_PORT: bad }), 4891, bad);
});

test("a value the engineer set wins; unset ones follow the environment", () => {
  const env = { EMBARCH_DESK_PORT: "4892", EMBARCH_DESK_CONFIG_DIR: "/s/c" };
  assert.deepEqual(core.resolveDeskEndpoint(undefined, undefined, env), { url: "http://127.0.0.1:4892", tokenPath: "/s/c/desk-token" });
  assert.deepEqual(core.resolveDeskEndpoint("http://localhost:1", "~/t", env), { url: "http://localhost:1", tokenPath: "~/t" });
  assert.deepEqual(core.resolveDeskEndpoint("http://localhost:1", undefined, env), { url: "http://localhost:1", tokenPath: "/s/c/desk-token" });
});
