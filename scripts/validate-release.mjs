#!/usr/bin/env node
/**
 * Pre-release validation script.
 *
 * Automatically catches two classes of packaging bugs that unit tests miss:
 *
 *   1. EXTERNAL DEPENDENCY GAPS — an external (non-bundled) package has a
 *      dependency that is not included in the VSIX, so the extension crashes
 *      at runtime with ERR_MODULE_NOT_FOUND.
 *
 *   2. PROPOSED API USAGE — extension.ts calls a VS Code proposed API without
 *      declaring it in package.json#enabledApiProposals, causing activation to
 *      fail with "CANNOT use API proposal: X".
 *
 * Both sets of checks are fully automatic:
 *
 *   • Externals are derived from the `bundle` esbuild script in package.json.
 *     Add a new --external:foo flag and this script checks foo automatically.
 *
 *   • Included VSIX packages are derived from .vscodeignore negation lines.
 *     Add a new !node_modules/bar/** line and bar is included in the check.
 *
 *   • Missing dep severity is auto-classified via a CJS require-interceptor:
 *       - Dep eagerly required AND not in VSIX  → ERROR (guaranteed runtime crash)
 *       - Dep declared but only lazily required  → WARN (feature degradation)
 *
 *   • Proposed API usage is detected by scanning dist/extension.js for known
 *     vscode.* method names. PROPOSED_API_MAP is the only list to maintain.
 *
 * Usage:
 *   node scripts/validate-release.mjs          # run standalone
 *   npm run validate:release                   # via package.json script
 *
 * Exit code 0 = OK (warnings allowed), 1 = hard errors found.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let _errors = 0;
let _warnings = 0;

function fail(msg)  { console.error(`  ❌ ${msg}`); _errors++; }
function warn(msg)  { console.warn( `  ⚠️  ${msg}`); _warnings++; }
function pass(msg)  { console.log(  `  ✅ ${msg}`); }
function info(msg)  { console.log(  `  ℹ️  ${msg}`); }
function section(t) { console.log(  `\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`); }

// ── 1. Parse package.json ─────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ── 2. Auto-discover externals from esbuild bundle command ───────────────────
//
// Reads the `bundle` script and extracts every --external:X flag.
// `vscode` is always available at runtime (injected by VS Code) so it is
// filtered out.  node: built-ins are also always available.

section('Detecting externals from bundle script');

const bundleScript = pkg.scripts?.bundle ?? '';
const externals = [...bundleScript.matchAll(/--external:([^\s]+)/g)]
    .map(m => m[1])
    .filter(e => e !== 'vscode' && !e.startsWith('node:'));

if (externals.length === 0) {
    warn('No --external: flags found in the bundle script — is the bundle script correct?');
} else {
    console.log(`  Found: ${externals.join(', ')}`);
}

// ── 3. Parse .vscodeignore to derive the VSIX node_modules ───────────────────
//
// Scans every negation line that matches  !node_modules/<pkg>/...
// and builds the set of top-level package names that will be present inside
// the installed extension's node_modules folder.

section('Deriving VSIX-included packages from .vscodeignore');

const vscodeignore = readFileSync(join(ROOT, '.vscodeignore'), 'utf8');
const includedPkgs = new Set();
for (const line of vscodeignore.split(/\r?\n/)) {
    // Matches: !node_modules/pkgname/   or   !node_modules/@scope/pkgname/
    const m = line.trim().match(/^!node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (m) { includedPkgs.add(m[1]); }
}

if (includedPkgs.size === 0) {
    warn('No !node_modules/... inclusions found in .vscodeignore');
} else {
    console.log(`  Included: ${[...includedPkgs].join(', ')}`);
}

// ── 4. Eager-load fingerprint via CJS require interceptor ────────────────────
//
// For each external, runs a subprocess that intercepts Module._resolveFilename
// to record every top-level package name actually resolved when require() is
// called on the external.  This lets us distinguish:
//
//   eager deps — resolved immediately at require() time
//               missing from VSIX → guaranteed runtime crash → ERROR
//   lazy deps  — resolved only when a specific feature is invoked
//               missing from VSIX → feature degradation → WARN
//
// The check runs against the FULL dev node_modules (so all requires succeed).
// We only use it to learn WHICH packages are touched, not whether they exist.

section('Building eager-load fingerprints via require interceptor');

/**
 * Returns the set of package names resolved when require(extName) runs.
 * Uses a CJS Module._resolveFilename interceptor in a subprocess.
 * @param {string} extName
 * @returns {Set<string>}
 */
function getEagerDeps(extName) {
    const tmpDir = join(tmpdir(), `cw-validate-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    const interceptFile = join(tmpDir, 'intercept.cjs');

    writeFileSync(interceptFile, `
const Module = require('module');
const builtins = new Set(require('module').builtinModules);
const logged = new Set();
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(request, ...args) {
    // Skip relative paths, node: built-ins, and CJS built-ins.
    if (!request.startsWith('.') && !request.startsWith('node:') && !builtins.has(request)) {
        let pkgName;
        // Absolute path (Windows C:\\... or Unix /...) — extract package from node_modules
        const nmIdx = request.replace(/\\\\/g, '/').lastIndexOf('/node_modules/');
        if (nmIdx !== -1 || /^[A-Za-z]:[\\\\\/]/.test(request) || request.startsWith('/')) {
            const rest = request.replace(/\\\\/g, '/').split('/node_modules/').pop() ?? '';
            pkgName = rest.startsWith('@')
                ? rest.split('/').slice(0, 2).join('/')
                : rest.split('/')[0];
        } else {
            pkgName = request.startsWith('@')
                ? request.split('/').slice(0, 2).join('/')
                : request.split('/')[0];
        }
        if (pkgName && pkgName !== request && !builtins.has(pkgName)) {
            logged.add(pkgName);
        }
    }
    return origResolve(request, ...args);
};
process.on('exit', () => process.stdout.write(JSON.stringify([...logged])));
`);

    const result = spawnSync(
        process.execPath,
        ['--require', interceptFile, '--eval', `require(${JSON.stringify(extName)})`],
        { cwd: ROOT, timeout: 30_000, encoding: 'utf8' },
    );

    try { writeFileSync(interceptFile, ''); } catch { /* best effort cleanup */ }

    if (result.error) {
        warn(`Interceptor subprocess failed for '${extName}': ${result.error.message}`);
        return new Set();
    }
    try { return new Set(JSON.parse(result.stdout || '[]')); }
    catch { return new Set(); }
}

/** @type {Map<string, Set<string>>} extName → eagerly loaded package names */
const eagerDepsMap = new Map();

for (const ext of externals) {
    if (!existsSync(join(ROOT, 'node_modules', ext, 'package.json'))) { continue; }
    const eager = getEagerDeps(ext);
    eagerDepsMap.set(ext, eager);
    const transitive = [...eager].filter(d => d !== ext);
    info(`'${ext}' eager deps: ${transitive.length ? transitive.join(', ') : '(none)'}`);
}

// ── 5. Dependency gap check ───────────────────────────────────────────────────
//
// For each external, compares declared deps against VSIX-included packages,
// using the eager-load fingerprint from step 4 to auto-classify severity:
//
//   dep is eagerly loaded AND not in VSIX  → ❌ ERROR  (runtime crash on load)
//   dep is declared but only lazy           → ⚠️  WARN  (degrades specific feature)
//   dep is optional AND not in VSIX         → ⚠️  WARN  (degraded functionality)
//   dep is in VSIX or nested locally        → ✅ OK

section('Checking dependency gaps against VSIX contents');

// ── KNOWN_SAFE_OMISSIONS ───────────────────────────────────────────────────────
//
// Packages listed as `dependencies` of an external but intentionally absent
// from the VSIX because they are never called at extension runtime.
//
//   prebuild-install   — runs only at `npm install` time to download pre-built
//                        native binaries; irrelevant at extension runtime.
//   @huggingface/jinja — @xenova/transformers uses this for chat-model Jinja
//                        template parsing; ChatWizard uses transformers for
//                        text embeddings only, so this code path is never hit.
const KNOWN_SAFE_OMISSIONS = new Set([
    'prebuild-install',
    '@huggingface/jinja',
]);

/**
 * @param {string} pkgName
 * @param {Set<string>} vsixPkgs
 * @param {Set<string>} eagerDeps  All packages eagerly loaded by the top-level external
 * @param {string} root
 * @param {string} [parentLabel]
 * @param {Set<string>} [visited]
 */
function checkDeps(pkgName, vsixPkgs, eagerDeps, root, parentLabel = pkgName, visited = new Set()) {
    if (visited.has(pkgName)) { return; }
    visited.add(pkgName);

    const pkgJsonPath = join(root, 'node_modules', pkgName, 'package.json');
    if (!existsSync(pkgJsonPath)) { return; }

    const meta     = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const required = Object.keys(meta.dependencies         ?? {});
    const optional = Object.keys(meta.optionalDependencies ?? {});

    for (const dep of required) {
        if (KNOWN_SAFE_OMISSIONS.has(dep)) { continue; } // intentionally omitted from VSIX
        const inVsix  = vsixPkgs.has(dep);
        const nested  = existsSync(join(root, 'node_modules', pkgName, 'node_modules', dep));
        const chain   = `${parentLabel} → ${dep}`;

        if (inVsix || nested) {
            if (inVsix) {
                checkDeps(dep, vsixPkgs, eagerDeps, root, chain, visited);
            }
        } else {
            if (eagerDeps.has(dep)) {
                fail(`${chain} [required, eagerly loaded] — NOT in VSIX → runtime crash`);
            } else {
                warn(`${chain} [required, lazy] — NOT in VSIX → feature degraded when used`);
            }
        }
    }

    for (const dep of optional) {
        const inVsix = vsixPkgs.has(dep);
        const nested = existsSync(join(root, 'node_modules', pkgName, 'node_modules', dep));
        if (!inVsix && !nested) {
            warn(`${parentLabel} → ${dep} [optional] — NOT in VSIX → reduced functionality`);
        }
    }
}

for (const ext of externals) {
    console.log(`\n  Checking: ${ext}`);

    if (!includedPkgs.has(ext)) {
        fail(`'${ext}' is --external in the bundle but NOT included in .vscodeignore — missing from VSIX entirely`);
        continue;
    }

    const pkgJsonPath = join(ROOT, 'node_modules', ext, 'package.json');
    if (!existsSync(pkgJsonPath)) {
        fail(`'${ext}' is not installed in node_modules — run npm install`);
        continue;
    }

    const eagerDeps = eagerDepsMap.get(ext) ?? new Set();
    checkDeps(ext, includedPkgs, eagerDeps, ROOT);
}

// ── 6. Proposed API usage check ───────────────────────────────────────────────
//
// Scans the compiled dist/extension.js for VS Code proposed API method names
// and verifies each is declared in package.json#enabledApiProposals.
//
// RULES for PROPOSED_API_MAP:
//   • Only add entries for vscode.* APIs that are gated behind a proposal flag.
//   • Do NOT add your own function names — only VS Code API method names.
//   • Stable APIs guarded by runtime typeof checks (e.g. vscode.chat.create*)
//     do NOT need entries here.
//   • Check https://github.com/microsoft/vscode/tree/main/src/vscode-dts
//     to determine whether an API is proposed or stable.

section('Proposed VS Code API usage vs enabledApiProposals');

/** @type {Record<string, string>} vsCodeApiMethodName → enabledApiProposals string */
const PROPOSED_API_MAP = {
    registerTimelineProvider:           'timeline',
    registerTerminalQuickFixProvider:   'terminalQuickFixProvider',
    registerMappedEditProvider:         'mappedEditsProvider',
    registerDocumentDropEditProvider:   'documentDropOrPaste',
    registerAITextItemProvider:         'aiTextItemProvider',
    registerInlineCompletionsProvider:  'inlineCompletionsAdditions',
};

const enabledProposals = new Set(pkg.enabledApiProposals ?? []);
const bundlePath = join(ROOT, 'dist', 'extension.js');

if (!existsSync(bundlePath)) {
    warn('dist/extension.js not found — run npm run bundle before validate:release');
} else {
    const bundleContent = readFileSync(bundlePath, 'utf8');
    let anyFound = false;

    for (const [apiName, proposal] of Object.entries(PROPOSED_API_MAP)) {
        if (bundleContent.includes(apiName)) {
            anyFound = true;
            if (!enabledProposals.has(proposal)) {
                // Detect if the call site is already wrapped in a try-catch.
                // A try-catch prevents activation crash but the API silently
                // does nothing — still worth flagging as a warning.
                // Search a window extending 100 chars before and 500 chars after
                // the method name to catch the try that wraps the actual .call().
                const offset = bundleContent.indexOf(apiName);
                const window = bundleContent.slice(Math.max(0, offset - 100), offset + 500);
                const guarded = /try\s*\{/.test(window);
                if (guarded) {
                    warn(`Proposed API '${apiName}' is in a try-catch but '${proposal}' missing from enabledApiProposals — will silently no-op in VS Code Insiders`);
                } else {
                    fail(`Proposed API '${apiName}' used in bundle but '${proposal}' NOT in enabledApiProposals → activation crash in VS Code Insiders`);
                }
            } else {
                pass(`'${apiName}' → proposal '${proposal}' correctly declared`);
            }
        }
    }

    if (!anyFound) {
        pass('No proposed API calls detected in bundle');
    }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(64));
if (_errors === 0 && _warnings === 0) {
    console.log('✅  All checks passed — safe to release.');
} else if (_errors === 0) {
    console.log(`⚠️   ${_warnings} warning(s) — review before releasing (not blocking).`);
} else {
    console.error(`❌  ${_errors} error(s), ${_warnings} warning(s) — fix before releasing.`);
    process.exit(1);
}
