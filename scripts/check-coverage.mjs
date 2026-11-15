#!/usr/bin/env node
/**
 * scripts/check-coverage.mjs
 *
 * Enforces the global coverage floor used by `npm run test:coverage`.
 *
 * The raw `coverage-summary.json` includes files the unit/e2e suites cannot
 * reach from an extension host (native-backed parsers, webview panels, the MCP
 * server, …) and the test files themselves, so those are subtracted before the
 * global percentages are compared with the thresholds.
 *
 * Living here instead of a `node -e "…"` one-liner in package.json means the
 * path handling is identical for Windows (`\`) and POSIX (`/`) separators, the
 * numbers are always printed (so a CI failure is diagnosable) and the shell
 * never has to survive a JSON-quoted regex.
 *
 * Usage:
 *   node scripts/check-coverage.mjs                       # coverage/coverage-summary.json
 *   node scripts/check-coverage.mjs path/to/summary.json  # explicit file
 */

import { readFileSync } from 'fs';
import { basename, resolve } from 'path';

// ── Policy ────────────────────────────────────────────────────────────────────

/** Global floor per metric (percent). */
const THRESHOLDS = {
    statements: 90,
    branches: 90,
    functions: 90,
    lines: 90,
};

/**
 * Files excluded from the global floor: not exercisable from the VS Code test
 * host, or the tests themselves. Matched on the file name so the same list
 * works with either path separator.
 */
const EXCLUDED_FILES = new Set([
    'fileWatcher.ts',
    'sessionWebviewPanel.ts',
    'analyticsPanel.ts',
    'codeBlocksPanel.ts',
    'mcpServer.ts',
    'chatParticipant.ts',
    'configPaths.ts',
    'timelineViewProvider.ts',
    'getContextTool.ts',
    'cursor.ts',
    'copilot.ts',
    'antigravity.ts',
    'copilotWorkspace.ts',
    'sessionTreeProvider.ts',
    'summaryGenerator.ts',
    'amazonQWorkspace.ts',
    'continueWorkspace.ts',
    'geminiCodeAssistWorkspace.ts',
    'sourceBrandIcons.ts',
    'fileAnchorResolver.ts',
    'promptLibraryPanel.ts',
    'semanticSearchPanel.ts',
    'semanticWiring.test.ts',
    'semanticIndexer.test.ts',
]);

// ── Load the istanbul summary ─────────────────────────────────────────────────

const summaryPath = resolve(process.argv[2] ?? 'coverage/coverage-summary.json');

let summary;
try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
} catch (error) {
    console.error(`\n[coverage] Cannot read ${summaryPath}: ${error.message}`);
    console.error('[coverage] Run `npm run test:coverage` first.\n');
    process.exit(1);
}

// ── Aggregate, skipping the excluded files ────────────────────────────────────

const metrics = Object.keys(THRESHOLDS);
const totals = {};
for (const metric of metrics) {
    totals[metric] = { total: 0, covered: 0 };
}

let countedFiles = 0;
let excludedFiles = 0;

for (const [file, data] of Object.entries(summary)) {
    if (file === 'total') { continue; }

    const excluded = EXCLUDED_FILES.has(basename(file));
    if (excluded) { excludedFiles++; } else { countedFiles++; }

    // Excluded files are removed from the aggregate entirely (numerator and
    // denominator), otherwise the floor would be measured against code that
    // cannot be covered.
    if (excluded) { continue; }

    for (const metric of metrics) {
        const entry = data[metric];
        if (!entry) { continue; }
        totals[metric].total += entry.total;
        totals[metric].covered += entry.covered;
    }
}

// ── Compare with the floor ────────────────────────────────────────────────────

const failures = [];
console.log(`\n[coverage] ${countedFiles} files counted, ${excludedFiles} excluded\n`);

for (const metric of metrics) {
    const { total, covered } = totals[metric];
    const pct = total > 0 ? (covered / total) * 100 : 100;
    const threshold = THRESHOLDS[metric];
    const ok = pct >= threshold;
    console.log(`[coverage] ${metric.padEnd(10)} ${pct.toFixed(2)}%  (min ${threshold}%)  ${ok ? 'OK' : 'BELOW'}`);
    if (!ok) { failures.push(`${metric} ${pct.toFixed(2)}% < ${threshold}%`); }
}

if (failures.length > 0) {
    console.error(`\n[coverage] FAILED: ${failures.join(', ')}\n`);
    process.exit(1);
}

console.log('\n[coverage] OK - every metric is at or above its threshold.\n');
