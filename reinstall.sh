#!/usr/bin/env bash
# Build this extension, package it as a .vsix, and sideload it into VS Code.
#
#   ./reinstall.sh                 build, package, install into the VS Code server
#   ./reinstall.sh --package-only  build and package; install nothing
#
# The extension is not on any marketplace, so nothing reinstalls it: when the
# VS Code server re-provisions its extensions directory (a server update
# does), the extension is dropped silently — the thread list's icon and the
# "EmbArch UI:" commands just stop appearing, while the settings survive.
# This script is the recovery path, and is safe to re-run at any time.
# It carries the embarch-ui launcher too (decision 29): uninstall the old
# standalone embarch-ui-launcher once this one is in.
#
# A .vsix is only a zip holding a manifest and the extension directory, so
# it is built with python's zipfile rather than with vsce. Everything the
# extension runs is bundled into dist/ by esbuild; no node_modules ship.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
die() { printf 'reinstall.sh: %s\n' "$*" >&2; exit 1; }

package_only=false
[[ "${1:-}" == "--package-only" ]] && package_only=true

# --- build ---------------------------------------------------------------
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  # The VS Code server ships its own node. Newest first.
  node_bin="$(ls -t "$HOME"/.vscode-server/bin/*/node 2>/dev/null | head -1 || true)"
fi
[[ -n "$node_bin" ]] || die "no node found (not on PATH, none bundled under ~/.vscode-server/bin/)"
[[ -d node_modules/esbuild ]] || die "node_modules/ is missing — run 'npm install' here first"
say "Building with $node_bin"
"$node_bin" build.mjs --production

# --- package -------------------------------------------------------------
# ExtensionKind is pinned to "workspace": the extension spawns the Linux
# claude and embarch-ui binaries, so it runs on the remote (WSL) side.
vsix="$(python3 - <<'PY'
import glob, json, os, zipfile
from xml.sax.saxutils import quoteattr, escape

pkg = json.load(open("package.json"))
repo = pkg.get("repository", {}).get("url", "")
vsix = f"{pkg['name']}-{pkg['version']}.vsix"

manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id={quoteattr(pkg['name'])} Version={quoteattr(pkg['version'])} Publisher={quoteattr(pkg['publisher'])} />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags></Tags>
    <Categories>{escape(','.join(pkg.get('categories', ['Other'])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value={quoteattr(pkg['engines']['vscode'])} />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value={quoteattr(repo)} />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
"""

content_types = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".css" ContentType="text/css"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".vsixmanifest" ContentType="text/xml"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".svg" ContentType="image/svg+xml"/></Types>
"""

with zipfile.ZipFile(vsix, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("extension.vsixmanifest", manifest)
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("extension/package.json", open("package.json", "rb").read())
    # Every bundle: the extension and both webviews. A missing file is a
    # webview that loads blank or an activation that throws — the same
    # silent symptom this script exists to fix. Source maps stay out.
    for f in sorted(glob.glob("dist/**/*", recursive=True)):
        if os.path.isfile(f) and not f.endswith(".map"):
            z.writestr(f"extension/{f}", open(f, "rb").read())
    for f in sorted(glob.glob("media/*")):
        z.writestr(f"extension/{f}", open(f, "rb").read())
    z.writestr("extension/readme.md", open("README.md", "rb").read())
    z.writestr("extension/LICENSE.txt", open("LICENSE", "rb").read())

print(vsix)
PY
)"
say "Packaged $vsix ($(du -h "$vsix" | cut -f1))"

if [[ "$package_only" == true ]]; then
  exit 0
fi

# --- install -------------------------------------------------------------
code_bin="$(command -v code || true)"
if [[ -z "$code_bin" ]]; then
  code_bin="$(ls -t "$HOME"/.vscode-server/bin/*/bin/remote-cli/code 2>/dev/null | head -1 || true)"
fi
[[ -n "$code_bin" ]] || die "no VS Code CLI found — install by hand: Extensions view → ... → Install from VSIX"

say "Installing with $code_bin"
"$code_bin" --install-extension "./$vsix" --force

say
say "Installed. Reload the VS Code window (Developer: Reload Window) for the"
say "thread list's icon, the chat in the secondary sidebar and the"
say "'EmbArch UI:' commands to appear. If embarch-ui-launcher is still"
say "installed, uninstall it: this extension carries its commands now."
