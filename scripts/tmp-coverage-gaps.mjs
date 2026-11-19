import { readFileSync } from 'fs';
import { basename } from 'path';

const EXCLUDED_FILES = new Set([
    'fileWatcher.ts', 'sessionWebviewPanel.ts', 'analyticsPanel.ts', 'codeBlocksPanel.ts',
    'mcpServer.ts', 'chatParticipant.ts', 'configPaths.ts', 'timelineViewProvider.ts',
    'getContextTool.ts', 'cursor.ts', 'copilot.ts', 'antigravity.ts', 'copilotWorkspace.ts',
    'sessionTreeProvider.ts', 'summaryGenerator.ts', 'amazonQWorkspace.ts', 'continueWorkspace.ts',
    'geminiCodeAssistWorkspace.ts', 'sourceBrandIcons.ts', 'fileAnchorResolver.ts',
    'promptLibraryPanel.ts', 'semanticSearchPanel.ts', 'semanticWiring.test.ts',
    'semanticIndexer.test.ts',
]);

const summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
const rows = [];
for (const [file, d] of Object.entries(summary)) {
    if (file === 'total') { continue; }
    const name = basename(file);
    if (EXCLUDED_FILES.has(name)) { continue; }
    const miss = (m) => (d[m] ? d[m].total - d[m].covered : 0);
    rows.push({
        name,
        path: file,
        bMiss: miss('branches'), fMiss: miss('functions'), lMiss: miss('lines'),
        b: d.branches.pct, f: d.functions.pct, l: d.lines.pct,
        bTot: d.branches.total, lTot: d.lines.total,
    });
}
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
console.log(`counted files: ${rows.length}  branchMiss=${sum('bMiss')} fnMiss=${sum('fMiss')} lineMiss=${sum('lMiss')}`);
console.log('\n--- top 25 by uncovered branches ---');
for (const r of [...rows].sort((a, b) => b.bMiss - a.bMiss).slice(0, 25)) {
    console.log(`${String(r.bMiss).padStart(4)}  fn:${String(r.fMiss).padStart(3)}  ln:${String(r.lMiss).padStart(4)}  b=${String(r.b).padStart(6)} f=${String(r.f).padStart(6)} l=${String(r.l).padStart(6)}  ${r.name}`);
}
console.log('\n--- top 20 by uncovered functions ---');
for (const r of [...rows].sort((a, b) => b.fMiss - a.fMiss).slice(0, 20)) {
    console.log(`${String(r.fMiss).padStart(3)}  b:${String(r.bMiss).padStart(4)}  ln:${String(r.lMiss).padStart(4)}  b=${String(r.b).padStart(6)} f=${String(r.f).padStart(6)} l=${String(r.l).padStart(6)}  ${r.name}`);
}
console.log('\n--- top 20 by uncovered lines ---');
for (const r of [...rows].sort((a, b) => b.lMiss - a.lMiss).slice(0, 20)) {
    console.log(`${String(r.lMiss).padStart(4)}  b:${String(r.bMiss).padStart(4)}  fn:${String(r.fMiss).padStart(3)}  b=${String(r.b).padStart(6)} f=${String(r.f).padStart(6)} l=${String(r.l).padStart(6)}  ${r.name}`);
}
