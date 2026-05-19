#!/usr/bin/env node
/**
 * scripts/detect-flaky.mjs
 *
 * Runs `npm test` N times (default 5) with the Mocha JSON reporter,
 * captures the set of passing/failing tests from each run, and diffs
 * across runs to identify tests whose outcome changes without any code change.
 *
 * Usage:
 *   node scripts/detect-flaky.mjs          # 5 runs
 *   node scripts/detect-flaky.mjs --runs 3 # custom run count
 *
 * Output:
 *   Prints a report of flaky tests (those that changed pass/fail status).
 *   Exits non-zero if any flaky tests are found.
 *
 * Known flakiness candidates in this codebase:
 *   - analyticsCache.test.ts: setTimeout-based debounce tests (race condition on slow CI)
 *   - analyticsCache.test.ts: wall-clock < 500ms performance assertion
 *   - embeddingEngine.test.ts: model download test (network-dependent, gated by CHATWIZARD_SLOW_TESTS)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const runsIdx = args.indexOf('--runs');
const RUNS = runsIdx !== -1 ? parseInt(args[runsIdx + 1], 10) : 5;

if (isNaN(RUNS) || RUNS < 2) {
    console.error('--runs must be a number ≥ 2');
    process.exit(1);
}

// ── Run test suite N times ────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatwizard-flaky-'));
/** @type {Array<{passing: Set<string>, failing: Set<string>}>} */
const runResults = [];

console.log(`\nRunning test suite ${RUNS} times to detect flakiness…\n`);

for (let i = 1; i <= RUNS; i++) {
    const outFile = path.join(tmpDir, `run-${i}.json`);
    console.log(`  Run ${i}/${RUNS}…`);

    try {
        // vscode-test doesn't support --reporter directly; use npm test and capture output.
        // We parse the text output to extract pass/fail information.
        const output = execSync('npm test 2>&1', {
            cwd: ROOT,
            encoding: 'utf-8',
            timeout: 300_000, // 5 minutes per run
        });
        fs.writeFileSync(outFile, output);

        const passing = new Set();
        const failing = new Set();

        // Parse mocha output lines: "  ✓ test name" / "  1) test name"
        for (const line of output.split('\n')) {
            const passMatch = line.match(/^\s+\d+\)\s+(.+)$/); // numbered failure
            const tickMatch = line.match(/^\s+✓\s+(.+?)(?:\s+\(\d+ms\))?$/);
            if (tickMatch) { passing.add(tickMatch[1].trim()); }
            if (passMatch) { failing.add(passMatch[1].trim()); }
        }

        runResults.push({ passing, failing });
        console.log(`     ✓ ${passing.size} passing, ${failing.size} failing`);
    } catch (err) {
        // execSync throws on non-zero exit (test failures) — capture the output anyway
        const output = err.stdout ?? err.message ?? '';
        fs.writeFileSync(outFile, output);

        const passing = new Set();
        const failing = new Set();
        for (const line of output.split('\n')) {
            const failMatch = line.match(/^\s+\d+\)\s+(.+)$/);
            const tickMatch = line.match(/^\s+✓\s+(.+?)(?:\s+\(\d+ms\))?$/);
            if (tickMatch) { passing.add(tickMatch[1].trim()); }
            if (failMatch) { failing.add(failMatch[1].trim()); }
        }
        runResults.push({ passing, failing });
        console.log(`     ! ${passing.size} passing, ${failing.size} failing`);
    }
}

// ── Diff across runs ──────────────────────────────────────────────────────────

// Collect all test names seen in any run
const allTests = new Set();
for (const run of runResults) {
    for (const t of run.passing) { allTests.add(t); }
    for (const t of run.failing) { allTests.add(t); }
}

const flaky = [];
for (const test of allTests) {
    const outcomes = runResults.map(r => {
        if (r.failing.has(test)) { return 'fail'; }
        if (r.passing.has(test)) { return 'pass'; }
        return 'absent';
    });
    const uniqueOutcomes = new Set(outcomes.filter(o => o !== 'absent'));
    if (uniqueOutcomes.size > 1) {
        flaky.push({ test, outcomes });
    }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
if (flaky.length === 0) {
    console.log(`✅  No flaky tests detected across ${RUNS} runs.\n`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
} else {
    console.log(`❌  ${flaky.length} flaky test(s) detected across ${RUNS} runs:\n`);
    for (const { test, outcomes } of flaky) {
        console.log(`  • ${test}`);
        console.log(`    Outcomes: ${outcomes.join(', ')}\n`);
    }
    console.log(`Raw run output saved to: ${tmpDir}`);
    process.exit(1);
}
