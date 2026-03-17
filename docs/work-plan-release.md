# ChatWizard — Release Checklist (VS Marketplace)

Tracks everything needed to publish v1.0.0 to the Visual Studio Marketplace.

---

## ~~1. Pre-flight: One-time Account & Tooling Setup~~

- [x] ~~**Create a Microsoft publisher account**~~
  - Go to https://marketplace.visualstudio.com/manage
  - Sign in with a Microsoft account, then create a publisher with ID `Veverke`
    (must match the `"publisher"` field in `package.json`).

- [x] ~~**Create an Azure DevOps Personal Access Token (PAT)**~~
  - Go to https://dev.azure.com → User Settings → Personal Access Tokens
  - New token → Scope: **Marketplace → Manage** (or "Full access")
  - Copy and store it securely; you will need it every time you publish.

- [x] ~~**Install `vsce`**~~
  ```
  npm install -g @vscode/vsce
  ```
  Verify: `vsce --version`

---

## ~~2. Required Assets~~

### ~~2a. Extension Icon~~

The Marketplace requires a 128×128 px PNG icon; without it the listing shows a generic placeholder.
This is now in place: `images/icon.png` exists and `package.json` points to it via the `icon` field.

- [x] ~~Create `images/icon.png` — 128×128 px PNG, transparent or solid background.~~
- [x] ~~Add the `icon` field to `package.json`:~~
  ```json
  "icon": "images/icon.png",
  ```
- [x] ~~Confirm `images/` is not excluded by `.vscodeignore`.~~
  The current `.vscodeignore` excludes `src`, `test`, `.vscode`, TypeScript sources, and sourcemaps,
  but it does not exclude `images/`, so the icon will be packaged.

### ~~2b. Gallery Banner~~ (optional but strongly recommended)

- [x] ~~Add `galleryBanner` to `package.json`.~~

```json
"galleryBanner": {
  "color": "#16324f",
  "theme": "dark"
},
```
This is now set in `package.json`.

### ~~2c. CHANGELOG.md~~

- [x] ~~Create `CHANGELOG.md` at the repo root.~~
  The Marketplace surfaces it as a "Changelog" tab. The content from `README.md §Release Notes`
  can be moved here verbatim:
  ```markdown
  # Change Log

  ## [1.0.0] - 2026-03-16

  Initial release. All nine development phases complete:
  - Phase 0: Foundation…
  …
  ```

---

## ~~3. `package.json` Issues to Fix~~

### ~~3a. Missing `keybindings` contribution~~

- [x] ~~Remove the stale README shortcut claim for Search.~~
  `chatwizard.search` currently has no contributed default keybinding, which matches the UIX plan
  decision to avoid conflicting with VS Code's native Replace in Files shortcut. The README now
  documents Command Palette access instead of advertising `Ctrl+Shift+H` / `Cmd+Shift+H`.

### ~~3b. License field — Marketplace compatibility~~

- [x] ~~Set `"license": "SEE LICENSE IN LICENSE"` in `package.json`.~~
  This avoids Marketplace warnings around non-standard SPDX `LicenseRef-*` identifiers while
  still pointing users to the repository license text.

### ~~3c. Optional metadata fields (improve discoverability)~~

- [x] ~~Add discoverability metadata in `package.json`.~~

```json
"bugs": { "url": "https://github.com/veverke/chatwizard/issues" },
"homepage": "https://github.com/veverke/chatwizard#readme",
```

---

## ~~4. Native Module — `better-sqlite3` Packaging~~

`better-sqlite3` is a native Node.js add-on (prebuilt `.node` binary). The Marketplace
distributes extensions cross-platform. You must either:

### Option A — Platform-specific packages (recommended)

Build and publish a separate `.vsix` per target platform. `vsce` supports this via `--target`:

```bash
# Windows x64
npm rebuild --arch=x64 --target_platform=win32
vsce package --target win32-x64

# Linux x64
npm rebuild --arch=x64 --target_platform=linux
vsce package --target linux-x64

# macOS arm64 (Apple Silicon)
npm rebuild --arch=arm64 --target_platform=darwin
vsce package --target darwin-arm64

# macOS x64
npm rebuild --arch=x64 --target_platform=darwin
vsce package --target darwin-x64
```

Then publish each:
```bash
vsce publish --packagePath chatwizard-1.0.0-win32-x64.vsix
vsce publish --packagePath chatwizard-1.0.0-linux-x64.vsix
# etc.
```

### Option B — Bundle prebuilt binaries for all platforms at once

Download the prebuilt `.node` binaries for all platforms (from the `better-sqlite3` GitHub
releases) and include them all in the package. This inflates the `.vsix` size but produces a
single universal package. Requires manual path-resolution logic in the extension loader.

### Option C — Remove `better-sqlite3` dependency

If you want to avoid native modules entirely, replace the SQLite reads for Copilot's
`state.vscdb` with a pure-JS SQLite library such as `sql.js` or `@sqlite.org/sqlite-wasm`.
Larger bundle but no platform-specific binaries needed.

> **Recommendation:** Option A (platform-specific) is the standard approach for VS Code
> extensions with native deps. It is what extensions like GitLens and SQLite Viewer use.

### Implementation Status

- [x] Added target-specific packaging scripts in `package.json`:
  - `npm run package:vsix:win32-x64`
  - `npm run package:vsix:linux-x64`
  - `npm run package:vsix:darwin-x64`
  - `npm run package:vsix:darwin-arm64`
- [x] Added CI matrix workflow at `.github/workflows/package-targeted-vsix.yml`.
  It builds one `.vsix` artifact per target on matching runners:
  - `win32-x64` on `windows-latest`
  - `linux-x64` on `ubuntu-latest`
  - `darwin-x64` on `macos-13`
  - `darwin-arm64` on `macos-14`

Run it from GitHub Actions via **workflow_dispatch**, or by pushing a `v*` tag.

---

## ~~5. `.vscodeignore` Review~~

- [x] ~~Applied packaging exclusions in `.vscodeignore`.~~

```gitignore
docs/**
.github/**
.claude/**
node_modules/.bin/**
node_modules/**/test/**
node_modules/**/tests/**
node_modules/**/*.md
node_modules/**/*.map
```

- [x] ~~Kept runtime essentials included (`out/**`, `images/**`, `node_modules/better-sqlite3/**`).~~
- [x] ~~Validated via package build.~~
  Current `win32-x64` output is reduced to 1010 files and ~5.64 MB, with docs and repo metadata removed from VSIX.

---

## ~~6. Final Build & Smoke Test~~

- [x] ~~`npm run compile` — must exit 0 with no errors.~~
- [x] ~~`npm run lint` — must exit 0 with no errors.~~
- [x] ~~`npm test` — all suites green.~~ 498/498 passing.
- [ ] Manual smoke test in Extension Development Host:
  - Sessions panel loads and shows sessions.
  - Search (`Ctrl+Shift+H`) opens QuickPick.
  - Code Blocks, Prompt Library, Analytics, Timeline tabs all render.
  - Export a single session to Markdown.

---

## 7. Package & Validate

```bash
# Preview what will be included — check for unexpected large files
vsce ls

# Dry-run package (creates the .vsix without publishing)
vsce package

# Check the generated .vsix size (aim for < 5 MB without native binaries; native adds ~2–4 MB per platform)
ls -lh *.vsix
```

Install locally to verify:
- Command Palette → "Extensions: Install from VSIX…" → select the `.vsix`
- Reload VS Code and confirm the extension activates correctly.

---

## 8. Publish to Marketplace

> **This is the point of no return.** Once `vsce publish` runs, the version goes live.
> The steps below must be completed in order. Nothing after `vsce publish` will affect
> the published extension — post-publish steps (GitHub tag, release notes, version bump)
> are housekeeping only.

### 8a. Make the repository public

- [ ] Go to **GitHub → ChatWizard repo → Settings → Danger Zone → Change visibility → Make public**.
  The Marketplace listing links to the repository (`homepage`, `bugs.url`, source links in README),
  so it must be public before the extension goes live.

### 8b. Final README check

- [ ] Confirm the README installation section covers both Marketplace and `.vsix` install paths.
  Suggested content (add/replace the existing Installation section):

```markdown
## Installation

### From the VS Code Marketplace (recommended)
1. Open VS Code.
2. Press `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS) to open the Extensions panel.
3. Search for **ChatWizard**.
4. Click **Install**.
5. Reload VS Code if prompted.

The extension activates automatically at startup — no configuration required for
standard GitHub Copilot Chat and Claude Code installations.

### From a .vsix file (manual)
1. Download the `.vsix` for your platform from the
   [GitHub Releases](https://github.com/Veverke/ChatWizard/releases) page.
2. Open VS Code.
3. Press `Ctrl+Shift+P` → **Extensions: Install from VSIX…**
4. Select the downloaded `.vsix` file.
5. Reload VS Code.

### First-run notes
- **GitHub Copilot Chat sessions** are discovered automatically from
  `%APPDATA%/Code/User/workspaceStorage` on Windows.
- **Claude Code sessions** are discovered automatically from `~/.claude/projects`.
- If your data is in a non-standard location, set the paths in
  **Settings → Extensions → ChatWizard** and reload the window.
```

### 8c. Update CHANGELOG.md

- [ ] Fill in the actual publish date in `CHANGELOG.md`:
  ```markdown
  ## [1.0.0] - 2026-03-17
  ```

### 8d. Build all platform VSIXs

Because `better-sqlite3` is a native add-on, a separate `.vsix` must be built on (or for)
each target platform. The npm scripts added in Section 4 handle this:

```bash
# Run each command on the matching OS/arch, or use the CI matrix workflow
# (.github/workflows/package-targeted-vsix.yml) which builds all four in parallel.

# Windows x64 — run on Windows
npm run package:vsix:win32-x64

# Linux x64 — run on Linux (or in WSL/CI)
npm run package:vsix:linux-x64

# macOS Intel — run on macOS x64
npm run package:vsix:darwin-x64

# macOS Apple Silicon — run on macOS arm64
npm run package:vsix:darwin-arm64
```

This produces four files:
```
chatwizard-win32-x64.vsix
chatwizard-linux-x64.vsix
chatwizard-darwin-x64.vsix
chatwizard-darwin-arm64.vsix
```

- [ ] Verify size of each `.vsix` (aim for ≤ 8 MB per platform-specific package):
  ```powershell
  Get-ChildItem *.vsix | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,2)}}
  ```

### 8e. Login to vsce

```bash
vsce login Veverke
# Paste your Azure DevOps PAT when prompted.
# Check: vsce whoami
```

- [ ] `vsce whoami` confirms you are logged in as `Veverke`.

### 8f. Publish all platform VSIXs

Publish each platform package with its matching `--target` flag. **All four must be
published before any one is visible to Marketplace users on its platform.**

```bash
vsce publish --packagePath chatwizard-win32-x64.vsix   --target win32-x64
vsce publish --packagePath chatwizard-linux-x64.vsix   --target linux-x64
vsce publish --packagePath chatwizard-darwin-x64.vsix  --target darwin-x64
vsce publish --packagePath chatwizard-darwin-arm64.vsix --target darwin-arm64
```

> If you only have one machine available right now, publish the platform you built
> locally first (e.g. `win32-x64`), then publish the others as CI artifacts become
> available. Users on unlisted platforms will see "not available for your platform"
> until all four are published.

- [ ] All four `vsce publish` commands exit 0.

### 8g. Verify the listing

- [ ] Confirm the listing appears at https://marketplace.visualstudio.com/items?itemName=Veverke.chatwizard
- [ ] Verify the icon, description, README, and CHANGELOG tabs display correctly.
- [ ] Install from the Marketplace in a fresh VS Code to confirm end-to-end activation.

---

## 9. Post-Release Housekeeping

These steps do **not** affect the published extension — do them after the Marketplace listing is live.

- [ ] Tag the release in git and push:
  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```
- [ ] Create a GitHub Release for `v1.0.0`:
  - Attach all four `.vsix` files as release assets.
  - Use the CHANGELOG entry as the release description.
- [ ] Bump `package.json` version to `1.0.1` (or `1.1.0`) and commit for the next dev cycle.

---

## Summary of Blockers (must fix before publish)

| # | Item | Severity | Status |
|---|------|----------|--------|
| 1 | ~~`better-sqlite3` native binary strategy~~ | ~~**BLOCKER** — extension will fail on non-build platform~~ | ~~Done — Option A (platform-specific VSIXs)~~ |
| 2 | ~~Missing extension icon (`images/icon.png` + `package.json` field)~~ | ~~High — poor Marketplace appearance~~ | ~~Done~~ |
| 3 | ~~Keybinding `Ctrl+Shift+H` not registered in `package.json`~~ | ~~High — advertised feature won't work for new users~~ | ~~Done — README updated to use Command Palette~~ |
| 4 | ~~CHANGELOG.md missing~~ | ~~Medium — Marketplace tab shows empty~~ | ~~Done~~ |
| 5 | ~~`"license"` field may be rejected~~ | ~~Medium — Marketplace validation~~ | ~~Done — `"SEE LICENSE IN LICENSE"`~~ |
| 6 | ~~`.vscodeignore` not trimmed~~ | ~~Low — oversized `.vsix`~~ | ~~Done — 1010 files / ~5.6 MB~~ |
| 7 | ~~`galleryBanner` not set~~ | ~~Low — cosmetic~~ | ~~Done~~ |
