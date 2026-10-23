// Just enough of the `vscode` module to activate the built extension in
// plain node and drive it: webviews are objects that record what the host
// posts and let a test post back as the page would; commands, quick picks,
// input boxes and messages are recorded or scripted.

const path = require("node:path");
const { EventEmitter } = require("node:events");

class Uri {
  constructor(scheme, p) {
    this.scheme = scheme;
    this.path = p;
    this.fsPath = p;
  }
  static file(p) {
    return new Uri("file", p);
  }
  static parse(s) {
    const m = /^([a-z][\w+.-]*):(.*)$/i.exec(s);
    return m ? new Uri(m[1], m[2]) : new Uri("file", s);
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, path.join(base.path, ...parts));
  }
  static from({ scheme, path: p }) {
    return new Uri(scheme, p);
  }
  toString() {
    return `${this.scheme}:${this.path}`;
  }
}

const disposable = (f = () => {}) => ({ dispose: f });

function event(em, name) {
  return (cb) => {
    em.on(name, cb);
    return disposable(() => em.off(name, cb));
  };
}

class FakeWebview {
  constructor() {
    this.em = new EventEmitter();
    this.posted = [];
    this.html = "";
    this.options = {};
    this.cspSource = "vscode-resource:";
    this.onDidReceiveMessage = event(this.em, "msg");
  }
  asWebviewUri(u) {
    return u;
  }
  async postMessage(m) {
    this.posted.push(JSON.parse(JSON.stringify(m)));
    this.em.emit("posted", m);
    return true;
  }
  /** What the page would post. */
  fromPage(m) {
    this.em.emit("msg", m);
  }
}

class FakeView {
  constructor() {
    this.webview = new FakeWebview();
    this.visible = true;
    this.badge = undefined;
    this.em = new EventEmitter();
    this.onDidChangeVisibility = event(this.em, "vis");
    this.onDidDispose = event(this.em, "dispose");
  }
}

// What package.json declares for each setting: its scope decides whether a
// workspace or folder value applies. VS Code ignores a workspace or folder
// value of a `machine`- or `application`-scoped setting (its documented
// behaviour; the Settings editor says "This setting cannot be applied in
// this workspace"), so a repo's .vscode/settings.json cannot set one.
const manifest = require(path.join(__dirname, "..", "package.json"));
const scopes = {};
for (const sec of manifest.contributes.configuration) for (const [k, v] of Object.entries(sec.properties)) scopes[k] = v.scope ?? "window";

const state = {
  /** User (or remote machine) settings. */
  config: {},
  /** A workspace's .vscode/settings.json. */
  workspaceConfig: {},
  commands: new Map(),
  executed: [],
  providers: new Map(),
  panels: [],
  messages: [],
  external: [],
  /** Paths given to openTextDocument. */
  opened: [],
  statusItems: [],
  quickPick: async () => undefined,
  inputBox: async () => undefined,
  folders: [],
  output: [],
  /** The editor's open documents: { uri, isDirty, save() }. */
  textDocuments: [],
  /** The Problems panel: [uri, diagnostics] pairs. */
  diagnostics: [],
  /** Content providers by scheme, and the documents shown in an editor. */
  contentProviders: new Map(),
  shown: [],
};

const vscode = {
  Uri,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  TextEditorRevealType: { InCenter: 2 },
  Position: class {
    constructor(l, c) {
      this.line = l;
      this.character = c;
    }
  },
  Range: class {
    constructor(a, b) {
      this.start = a;
      this.end = b;
    }
  },
  Selection: class {
    constructor(a, b) {
      this.start = a;
      this.end = b;
    }
  },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => state.output.push(l), append: (l) => state.output.push(l), show() {}, dispose() {} }),
    // Both signatures: (alignment, priority) and (id, alignment, priority).
    createStatusBarItem: (...args) => {
      const id = typeof args[0] === "string" ? args.shift() : undefined;
      const it = { id, alignment: args[0] ?? 1, priority: args[1], name: undefined, text: "", tooltip: "", command: undefined, visible: false, show() {
        this.visible = true;
      }, hide() {
        this.visible = false;
      }, dispose() {} };
      state.statusItems.push(it);
      return it;
    },
    registerWebviewViewProvider: (id, provider, opts) => {
      state.providers.set(id, { provider, opts });
      return disposable();
    },
    createWebviewPanel: (viewType, title) => {
      const em = new EventEmitter();
      const p = { viewType, title, webview: new FakeWebview(), iconPath: undefined, reveal() {}, onDidDispose: event(em, "dispose"), dispose: () => em.emit("dispose") };
      state.panels.push(p);
      return p;
    },
    showErrorMessage: async (m) => void state.messages.push(["error", m]),
    showWarningMessage: async (m) => void state.messages.push(["warning", m]),
    showInformationMessage: async (m) => void state.messages.push(["info", m]),
    showQuickPick: (items, opts) => state.quickPick(items, opts),
    showInputBox: (opts) => state.inputBox(opts),
    showTextDocument: async (doc, opts) => (state.shown.push({ doc, opts }), { selection: null, revealRange() {} }),
    activeTextEditor: undefined,
    terminals: [],
  },
  workspace: {
    get workspaceFolders() {
      return state.folders.map((f) => ({ uri: Uri.file(f), name: path.basename(f) }));
    },
    get textDocuments() {
      return state.textDocuments;
    },
    getConfiguration: (section) => ({
      get: (k, d) => {
        const key = `${section}.${k}`;
        const machineOnly = scopes[key] === "machine" || scopes[key] === "application";
        if (!machineOnly && key in state.workspaceConfig) return state.workspaceConfig[key];
        return key in state.config ? state.config[key] : d;
      },
    }),
    onDidChangeConfiguration: () => disposable(),
    registerTextDocumentContentProvider: (scheme, provider) => {
      state.contentProviders.set(scheme, provider);
      return disposable(() => state.contentProviders.delete(scheme));
    },
    findFiles: async () => [],
    openTextDocument: async (p) => {
      state.opened.push(String(p));
      // A virtual document: its provider's text, as VS Code reads it.
      const provider = p && typeof p === "object" && state.contentProviders.get(p.scheme);
      return provider ? { uri: p, languageId: "plaintext", getText: () => provider.provideTextDocumentContent(p) } : null;
    },
  },
  languages: {
    setTextDocumentLanguage: async (doc, languageId) => ({ ...doc, languageId }),
    getDiagnostics: (uri) => (uri ? (state.diagnostics.find(([u]) => u.fsPath === uri.fsPath)?.[1] ?? []) : state.diagnostics),
  },
  commands: {
    registerCommand: (id, fn) => {
      if (state.commands.has(id)) throw new Error(`command '${id}' already exists`);
      state.commands.set(id, fn);
      return disposable(() => state.commands.delete(id));
    },
    executeCommand: async (id, ...args) => {
      state.executed.push(id);
      const f = state.commands.get(id);
      return f ? f(...args) : undefined;
    },
  },
  extensions: { getExtension: () => undefined },
  env: { openExternal: async (u) => (state.external.push(String(u)), true) },
};

module.exports = { vscode, state, scopes, FakeView, FakeWebview };
