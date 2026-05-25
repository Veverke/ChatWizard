// Full diagnostic: what sessions match intent.md via all 3 tiers
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Configure via environment variables or replace the placeholders with local paths.
const DB = process.env['CW_DB_PATH']
    ?? 'C:/Users/<username>/AppData/Roaming/Code - Insiders/User/globalStorage/GitHub.copilot-chat/session-store.db';
const SIDECAR = process.env['CW_SIDECAR_PATH']
    ?? 'C:/Users/<username>/AppData/Roaming/Code - Insiders/User/globalStorage/veverke.chatwizard/chatwizard-metadata.json';
const QUERY_NORM = process.env['CW_QUERY_PATH'] ?? 'c:/_/chatwizard/docs/intent.md';
const BASENAME = QUERY_NORM.split('/').pop() ?? 'intent.md';

// --- helper: same as normalisePath (no symlink resolution, just slashes + drive) ---
function normPath(p) {
    if (!p) return '';
    return p.replace(/\\/g, '/').replace(/^([A-Z]):\//, (_, d) => `${d.toLowerCase()}:/`).toLowerCase();
}

// --- TIER 1+2: Chronicle session_files ---
const db = new DatabaseSync(DB, { readOnly: true });
const chronicleMatches = db.prepare(
    `SELECT DISTINCT s.id, s.summary
     FROM sessions s
     JOIN session_files sf ON sf.session_id = s.id
     WHERE lower(replace(sf.file_path,'\\\\','/')) LIKE ?`
).all('%intent.md%');
console.log(`=== Tier 1/2 — Chronicle session_files matching intent.md: ${chronicleMatches.length} ===`);
for (const r of chronicleMatches) console.log(`  [${r.id}] ${r.summary?.slice(0,80)}`);

// Also check checkpoints table for important_files
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
if (tables.includes('checkpoints')) {
    const cpCols = db.prepare("PRAGMA table_info(checkpoints)").all().map(c => c.name);
    console.log(`\ncheckpoints columns: ${cpCols.join(', ')}`);
    if (cpCols.includes('important_files')) {
        const cp = db.prepare(`SELECT session_id, important_files FROM checkpoints WHERE important_files LIKE '%intent%' LIMIT 10`).all();
        console.log(`checkpoints with intent.md in important_files: ${cp.length}`);
        cp.forEach(r => console.log(`  session=${r.session_id} files=${r.important_files?.slice(0,100)}`));
    }
}
db.close();

// --- TIER 3: Sidecar entity extraction ---
let sidecarHits = 0;
try {
    const sidecar = JSON.parse(readFileSync(SIDECAR, 'utf8'));
    const total = Object.keys(sidecar).length;
    console.log(`\n=== Tier 3 — Sidecar entities (${total} sessions in sidecar) ===`);
    for (const [id, meta] of Object.entries(sidecar)) {
        const fps = meta?.entities?.filePaths ?? [];
        // Tier 3: basename match
        const hit = fps.some(f => (f.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase() === BASENAME);
        if (hit) {
            sidecarHits++;
            console.log(`  [${id}] ${meta.customTitle ?? '(no custom title)'}`);
            console.log(`    filePaths: ${fps.slice(0, 5).join(', ')}`);
        }
    }
    console.log(`Total sidecar entity matches: ${sidecarHits}`);
} catch (e) { console.log(`Sidecar read error: ${e.message}`); }

// Summary
console.log(`\n=== SUMMARY ===`);
console.log(`Chronicle matches: ${chronicleMatches.length}`);
console.log(`Sidecar entity matches: ${sidecarHits}`);
console.log(`Total unique (approximate): ${chronicleMatches.length + sidecarHits}`);
