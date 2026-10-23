// Builds the extension (Node, CommonJS) and its two webviews (Preact,
// browser IIFE) with esbuild (decision 21); `--tests` builds the pure core
// the node tests import; `--watch` rebuilds on change.

import * as esbuild from "esbuild";
import * as fs from "node:fs";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");
const prod = process.argv.includes("--production");

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: "info", target: "es2022" };

const builds = tests
  ? [
      {
        ...common,
        entryPoints: { core: "src/core.ts" },
        outdir: "test-out",
        platform: "node",
        format: "cjs",
        sourcemap: false,
        logLevel: "warning",
      },
    ]
  : [
      {
        ...common,
        entryPoints: { extension: "src/extension.ts" },
        outdir: "dist",
        platform: "node",
        format: "cjs",
        external: ["vscode"],
      },
      {
        ...common,
        entryPoints: { chat: "webview/chat/index.tsx", list: "webview/list/index.tsx" },
        outdir: "dist/webview",
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        jsxImportSource: "preact",
        loader: { ".css": "css" },
      },
    ];

if (!tests) {
  fs.mkdirSync("dist/webview", { recursive: true });
}

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
