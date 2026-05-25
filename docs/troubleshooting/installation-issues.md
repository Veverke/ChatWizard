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
   ever published, regardless of whether the feature is reachable by tests.
