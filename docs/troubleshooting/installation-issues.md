# VSIX Packaging & Installation Issues

This document describes a packaging investigation that revealed semantic search was
never functional in any public release prior to 1.6.0, and the CI safeguards added
to prevent similar silent failures from shipping again.

---

## The Problem: Semantic Search Was Never Loaded

### What the changelog said

The 1.3.0 release notes introduced semantic search:

> "powered by a local `Xenova/all-MiniLM-L6-v2` ONNX model (~22 MB,
> **downloaded on first use** after a consent prompt;
> `@xenova/transformers` **bundled externally**)."

The phrase "downloaded on first use" referred to the **model weights** (the `.onnx`
file fetched from HuggingFace when a user first enabled the feature). The phrase
"bundled externally" meant the `@xenova/transformers` npm package was included in the
VSIX but kept external from the esbuild bundle (loaded via `require()` at runtime
rather than being inlined into `dist/extension.js`).

### What actually happened

`@xenova/transformers` v2.17.2 is an ESM-only package. Its entry points contain
**static top-level imports** that cannot be caught by a try/catch:

```js
// node_modules/@xenova/transformers/src/backends/onnx.js
import * as ONNX_NODE from 'onnxruntime-node';   // static
import * as ONNX_WEB  from 'onnxruntime-web';    // static

// node_modules/@xenova/transformers/src/utils/image.js
import * as sharp from 'sharp';                   // static
```

The VSIX included the `@xenova/transformers` package itself but **never included
`onnxruntime-web` or `sharp`**. When VS Code's extension host called
`require('@xenova/transformers')`, Node.js attempted to resolve all static imports
and immediately threw `ERR_MODULE_NOT_FOUND`. The entire library failed to load.

Because the call site in `extension.ts` used a fire-and-forget pattern:

```ts
void indexer.initialize().then(...);
```

the error was silently swallowed. Semantic search appeared to activate without
complaint but returned no results for every query.

### Why the model download never mattered

The 22 MB model weights are fetched inside `pipeline()`, which is called only after
`require('@xenova/transformers')` succeeds and the `EmbeddingEngine` initialises.
Since that `require()` always threw, the download code was never reached.

### Timeline

| Version | Status |
|---------|--------|
| Pre-public builds (esbuild bundled @xenova/transformers inline) | Worked — esbuild resolved and bundled the transitive deps |
| 1.3.0 — switched to `--external:@xenova/transformers` without carrying across the runtime deps | **Broken from first public release** |
| 1.4.0, 1.5.0 | Still broken — no packaging change |
| 1.6.0 | Fixed by Option A (see below) |

The switch from bundled to external happened to coincide with the restructured
`.vscodeignore` that excluded all of `node_modules/**` and only re-included
specific packages by name. `onnxruntime-web` and `sharp` were simply not added.

---

## Root Cause: Static Imports in an ESM Package

In Node.js 22+ (VS Code 1.90+), `require()` of an ESM package is supported
synchronously. However, all **static** imports in that module's dependency graph
must resolve — the same as if the module were loaded via `import`. A static import
of a missing package is not recoverable; there is no `try/catch` equivalent at the
module boundary.

Key facts about the dependencies:

| Package | Why imported | Why never *called* |
|---------|-------------|-------------------|
| `onnxruntime-web` (65 MB) | Static import at top of `backends/onnx.js` | `RUNNING_LOCALLY = true` in VS Code → always uses `onnxruntime-node` |
| `sharp` (48 MB) | Static import at top of `utils/image.js` | ChatWizard uses text-only embeddings; image processing is never invoked |
| `onnxruntime-node` (92 MB all platforms) | Also statically imported | **This one is needed** — it runs the actual inference |

---

## The Fix: Option A — Stubs + Platform-Specific Binary

### Stubs for onnxruntime-web and sharp

Two 2 KB stub packages are created at packaging time as nested modules inside
`@xenova/transformers`:

```
node_modules/@xenova/transformers/node_modules/
  onnxruntime-web/
    package.json   {"name":"onnxruntime-web","version":"0.0.0-vsix-stub","main":"index.js"}
    index.js       module.exports = {};
  sharp/
    package.json   {"name":"sharp","version":"0.0.0-vsix-stub","main":"index.js"}
    index.js       module.exports = {};
```

Node.js module resolution checks the closest `node_modules/` first, so these stubs
shadow the absent real packages. The `.vscodeignore` glob
`!node_modules/@xenova/transformers/**` already includes everything nested inside,
so no extra packaging rules are needed.

### Platform-specific onnxruntime-node binary

`onnxruntime-node` bundles pre-built binaries for all platforms (92 MB total). Each
platform-specific VSIX includes only the relevant binary:

| Platform VSIX | Binary added | VSIX size increase |
|---|---|---|
| win32-x64 | 9.1 MB | +9 MB |
| linux-x64 | 15.8 MB | +16 MB |
| darwin-arm64 | 20.4 MB | +20 MB |
| darwin-x64 | 22.9 MB | +23 MB |

The resulting VSIX sizes (approximately 28–38 MB compressed) are well within
the VS Code Marketplace's 100 MB per-platform limit and comparable to extensions
such as Pylance (~45 MB) or the Python extension (~50 MB).

### How packaging works

A new script, `scripts/package-vsix.mjs`, wraps the `vsce package` call:

1. Creates the two stub packages in `node_modules/@xenova/transformers/node_modules/`
2. Appends the platform-specific `onnxruntime-node` include lines to `.vscodeignore`
3. Calls `npx @vscode/vsce package --target <platform>`
4. In a `finally` block: removes the stubs and reverts `.vscodeignore`

The `package:vsix:*` scripts in `package.json` now delegate to this wrapper:

```json
"package:vsix:win32-x64": "npm run rebuild:native && npm run bundle && node scripts/package-vsix.mjs win32-x64"
```

### The model download — unchanged behaviour

The 22 MB `all-MiniLM-L6-v2` ONNX model weights are still downloaded from
HuggingFace on first use after the user consents. This is handled entirely by
`@xenova/transformers` and requires an internet connection the first time. Subsequent
uses are served from the local cache.

---

## How the Bug Was Found: The Quality Gate

The `scripts/validate-release.mjs` quality gate runs as part of `vscode:prepublish`
(triggered automatically by every `vsce package` call). It:

1. Auto-discovers external packages from the `--external:*` flags in the `bundle`
   esbuild script.
2. Derives the set of VSIX-included packages from `!node_modules/...` negation lines
   in `.vscodeignore`.
3. Runs a CJS `Module._resolveFilename` interceptor in a subprocess to fingerprint
   which packages are **eagerly loaded** when each external is `require()`d.
4. For each transitive dependency:
   - `required` + eagerly loaded + not in VSIX → **ERROR** (blocks build, exits 1)
   - `required` + lazy + not in VSIX → **WARNING**
   - `optional` + not in VSIX → **WARNING**

Before the fix, the gate produced two hard errors:

```
❌ @xenova/transformers → onnxruntime-web [required, eagerly loaded] — NOT in VSIX → runtime crash
❌ @xenova/transformers → sharp          [required, eagerly loaded] — NOT in VSIX → runtime crash
```

These errors correctly blocked all VSIX builds, which is why no further broken
releases were shipped after the gate was introduced. After applying Option A, both
errors resolve and the gate exits 0.

---

## CI Safeguards Added

Three layers of CI protection were added during this investigation to catch
installation-level surprises before they reach users:

### 1. validate:release quality gate (vscode:prepublish)

`npm run validate:release` runs automatically on every `vsce package` invocation.
Any packaging ERROR (missing eager dep, undeclared proposed API) blocks the VSIX
build before a file is created. This gate is the primary defence against
"works in dev, crashes in production" packaging bugs.

**Files changed:** `scripts/validate-release.mjs`, `package.json` (`vscode:prepublish`)

### 2. VS Code Stable + Insiders matrix in CI

`ci.yml` now tests against both VS Code `stable` and `insiders` on every push:

```yaml
strategy:
  matrix:
    vscode-version: [stable, insiders]
```

Coverage upload is gated to `ubuntu-latest && stable` to avoid double-counting.
This catches API breakage introduced in upcoming VS Code releases before they
graduate to stable.

**File changed:** `.github/workflows/ci.yml`

### 3. test-insiders job gates all VSIX builds in release.yml

`release.yml` now has a `test-insiders` job that runs the full test suite (unit +
integration) against VS Code Insiders before any platform VSIX is built:

```yaml
test-insiders:
  needs: verify-version
  runs-on: ubuntu-latest
  steps:
    - run: xvfb-run -a npm test -- --vscode-version=insiders
    - run: xvfb-run -a npm run test:integration -- --vscode-version=insiders

build:
  needs: [verify-version, test-insiders]
```

A release cannot proceed to packaging if the Insiders test run fails.

**File changed:** `.github/workflows/release.yml`

---

## Lessons Learned

1. **Fire-and-forget async hides load failures.** `void promise.then(...)` makes
   it trivially easy to ship a feature that silently never works. Critical
   initialisation paths should surface failures to the user (e.g. a status bar
   warning or output channel message) rather than swallowing them.

2. **External packages require transitive dep auditing.** Marking a package
   `--external` in esbuild shifts the responsibility for packaging its entire
   dependency tree to `.vscodeignore`. ESM packages with static imports of
   native or large packages are especially risky because there is no runtime
   fallback path.

3. **A quality gate at packaging time is more reliable than runtime checks.**
   The `validate:release` script detects these issues in CI before a VSIX is

---

## "Commands view shows 0 commands after installing a new VSIX"

### Symptom

After installing a freshly packaged VSIX, the **Commands** view lists nothing in
all three sections (Executed Commands, Unified Timeline, Diff Explorer) even
though `chatwizard-log-events.db` is full and the **Sessions** view works.

### Root cause

`better-sqlite3` is a **native** module compiled for one
`NODE_MODULE_VERSION` (ABI). `npm install` compiles it for the host Node.js ABI,
while the extension host runs inside VS Code's Electron, which uses a different
ABI. When the ABIs do not match the binding cannot be loaded, so:

- `LogService` degrades to its **in-memory** event store (empty at startup) →
  the Commands view shows 0 rows in every section;
- `CacheIntegration` fails too → sessions are re-parsed from disk instead of
  being served from `chatwizard-cache.db` (Sessions still works, just slower).

Nothing is lost: the database is untouched.

### Why it appeared "suddenly"

A new VS Code major upgrade changes Electron's ABI (e.g. VS Code 1.146 ships
Electron 43.8.6 / ABI **148**, while a Node 24 build is ABI **137**). Two
packaging traps made this silent:

1. `scripts/rebuild-native.js` skipped the rebuild because a **stale marker
   file** still named the previous Electron version — `npm install` had replaced
   `better_sqlite3.node` with a Node-ABI prebuild without touching the marker.
2. The installed VS Code no longer advertises `electronVersion` in
   `resources/app/package.json`, so the script fell back to a hard-coded
   Electron version that did not match.

### How to verify

1. The Chat Wizard output channel now logs the host identity on activation:
   `Extension host: VS Code …, Electron …, Node …, NODE_MODULE_VERSION …`, plus
   `Watch-logs event store running IN MEMORY (…)` when the binding failed.
2. Watch for the one-time warning notification:
   *"agent-log storage is unavailable for this VS Code version, so the Commands
   view starts empty"*.

### Fix

```powershell
npm run rebuild:native
```

The script now:

- reads **`vscode-host-runtime.json`** from the shared cache directory (written
  by the running extension, so it always names the *installed* VS Code's
  Electron version) — `VSCODE_ELECTRON_VERSION` still overrides it;
- fingerprints the compiled `better_sqlite3.node` (mtime + size) in the marker,
  so replacing the binary via `npm install` forces a rebuild instead of being
  skipped;
- prints the remediation steps when the Windows C++ toolchain is incomplete.

Then repackage/install the VSIX (`npm run package:vsix:win32-x64`), which runs
`rebuild:native` first.

   ever published, regardless of whether the feature is reachable by tests.

---

## "Could not find any Python installation to use" / rebuild fails on a locked-down machine

`npm run build:install:vscode` → `package:vsix:<platform>` → `rebuild:native`
compiles `better-sqlite3` with node-gyp. On a corporate Windows machine three
*independent* problems can stop that compile. They surface one after another, so
fixing one only reveals the next.

### 1. `Error: Could not find any Python installation to use`

node-gyp's Python search is narrow. In order it probes:

1. `--python` / `NODE_GYP_FORCE_PYTHON` / `PYTHON`
2. the `py.exe` launcher
3. `python3` and `python` on `PATH`
4. `%LOCALAPPDATA%\Programs\Python\Python{311,310,39,38}\python.exe` and the
   equivalent `%ProgramFiles%` locations

Two very common setups match none of these:

- **uv-managed interpreters** — uv installs CPython to
  `%APPDATA%\uv\python\cpython-<version>-windows-x86_64-none\python.exe` and does
  **not** put it on `PATH`. Only `python3.15.exe`-style shims appear in
  `%USERPROFILE%\.local\bin`, and node-gyp looks for the exact names
  `python3` / `python`.
- **The Microsoft Store alias** — `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`
  is a 0-byte stub that prints *"Python was not found; run without arguments to
  install from the Microsoft Store"* and exits with code **9009**. When that
  directory precedes a real install in `PATH`, node-gyp's probe fails even though
  Python *is* installed.

`scripts/rebuild-native.js` now resolves the interpreter itself (explicit env →
`PATH` → `uv python find` → install dirs, rejecting the Store stub by exit code
and by path) and exports the result as `PYTHON` for the `@electron/rebuild`
child, which node-gyp then uses. When nothing usable is found it prints the
remediation instead of node-gyp's opaque message.

Manual equivalents:

```powershell
uv python install --default        # adds python.exe to %USERPROFILE%\.local\bin (ahead of the Store alias)
setx PYTHON "C:\Path\To\python.exe"  # any interpreter; needs a new shell
npm config set python "C:\Path\To\python.exe"
```

### 2. `Error: Could not find any Visual Studio installation to use`

This appears *after* Python is fixed, and it is usually a false negative: VS with
"Desktop development with C++" and the Windows SDK are installed, but node-gyp
cannot enumerate them. node-gyp finds VS by compiling `Find-VisualStudio.cs` at
run time with PowerShell's `Add-Type`; endpoint protection (Avecto, AppLocker,
some EDR products) denies writing the compiler response file, so the compile
fails and node-gyp reports "no Visual Studio":

```
Add-Type : (0) : Error opening response file
'C:\Users\<user>\AppData\Local\Temp\<tmp>\<tmp>.cmdline' -- 'Access is denied.'
...
FullyQualifiedErrorId : COMPILER_ERRORS,Microsoft.PowerShell.Commands.AddTypeCommand
```

(node-gyp only shows those details with `npm_config_loglevel=silly`.)

When `VCINSTALLDIR`, `VSCMD_VER` and `WindowsSDKVersion` are set, node-gyp takes
its VS-developer-prompt fast path and never invokes PowerShell. The script now
derives those three values with `vswhere` + the installed SDK and exports them,
so no developer prompt is required. Note node-gyp computes the VS root as
`path.resolve(VCINSTALLDIR, '..')`, so `VCINSTALLDIR` must end in `\VC`.

Manual equivalent:

```powershell
$env:VCINSTALLDIR      = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC'
$env:VSCMD_VER         = '18.12.12405.243'      # vswhere -property installationVersion
$env:WindowsSDKVersion = '10.0.26100.0\'        # trailing backslash, as in VsDevCmd
npm run rebuild:native
```

### 3. `Error: unable to get local issuer certificate` (code `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)

Raised while node-gyp downloads the Electron headers on first use (nothing is
cached in `%USERPROFILE%\.electron-gyp` yet). TLS inspection proxies re-sign the
connection with an internal CA that lives in the Windows certificate store —
which Node.js does **not** read. Point Node at a PEM export of that CA:

```powershell
$out = "$env:USERPROFILE\.certs\corporate-root-ca.pem"
$sb = New-Object System.Text.StringBuilder
foreach ($loc in 'LocalMachine','CurrentUser') {
  foreach ($store in 'Root','CA') {
    $s = New-Object System.Security.Cryptography.X509Certificates.X509Store($store, $loc)
    try { $s.Open('ReadOnly'); foreach ($c in $s.Certificates) {
      if ($c.Subject -notmatch 'YourProxyRootCA|YourEnterpriseCA') { continue }
      [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
      [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, 'InsertLineBreaks'))
      [void]$sb.AppendLine('-----END CERTIFICATE-----')
    } } finally { $s.Close() }
  }
}
Set-Content -Path $out -Value $sb.ToString() -Encoding ascii
setx NODE_EXTRA_CA_CERTS $out
```

The root *and* the issuing intermediate both have to be in the bundle — a chain
that only misses the intermediate fails with the same error. Once the headers
are in `%USERPROFILE%\.electron-gyp\<electron-version>`, later builds no longer
download anything.

### 4. `Need to install the following packages: @vscode/vsce … Ok to proceed? (y)`

`@vscode/vsce` is resolved through `npx`, so on a machine without it cached npx
stops for confirmation and hangs every non-interactive run. `package-vsix.mjs`
now passes `npx --yes`. If a run is interrupted at that prompt, press `n`, then
run `git checkout -- .vscodeignore` and delete
`node_modules/@xenova/transformers/node_modules` — the script's `finally` block
(stub cleanup + `.vscodeignore` revert) does not execute when the process is
killed.

