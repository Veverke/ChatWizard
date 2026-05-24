// Diagnostic: check which sessions match intent.md using the same logic as CwTimelineProvider
import { DatabaseSync } from 'node:sqlite';

const dbPath = 'C:/Users/ay250177/AppData/Roaming/Code - Insiders/User/globalStorage/GitHub.copilot-chat/session-store.db';
const QUERY_PATH = 'c:/_/chatwizard/docs/intent.md';
const QUERY_BASENAME = 'intent.md';

const db = new DatabaseSync(dbPath, { readOnly: true });

// Show tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '), '\n');

// Check session_files table (Chronicle data)
const hasSessionFiles = tables.some(t => t.name === 'session_files');
if (hasSessionFiles) {
    const rows = db.prepare(`SELECT session_id, file_path FROM session_files WHERE file_path LIKE '%intent%' LIMIT 20`).all();
    console.log(`session_files matching intent.md: ${rows.length}`);
    for (const r of rows) console.log(`  session=${r.session_id}  path=${r.file_path}`);
} else {
    console.log('No session_files table found');
}

// Check sessions table for importantFiles JSON
const hasSessions = tables.some(t => t.name === 'sessions');
if (hasSessions) {
    const cols = db.prepare("PRAGMA table_info(sessions)").all();
    console.log('\nsessions columns:', cols.map(c => c.name).join(', '));

    // Look for sessions with intent.md in important_files or similar JSON column
    const allSessions = db.prepare("SELECT id, title, important_files FROM sessions LIMIT 200").all();
    const matches = allSessions.filter(s => {
        if (!s.important_files) return false;
        try {
            const files = JSON.parse(s.important_files);
            return files.some(f => f.toLowerCase().includes('intent.md'));
        } catch { return false; }
    });
    console.log(`\nSessions with intent.md in important_files: ${matches.length}`);
    for (const m of matches) console.log(`  [${m.id}] ${m.title}`);
}

// Check entities / sidecar / other tables
for (const t of tables) {
    if (['sessions', 'session_files'].includes(t.name)) continue;
    const cols = db.prepare(`PRAGMA table_info([${t.name}])`).all();
    const cnt = db.prepare(`SELECT COUNT(*) as n FROM [${t.name}]`).get();
    console.log(`\n${t.name} (${cnt.n} rows): ${cols.map(c => c.name).join(', ')}`);

    // Check if any text column mentions intent.md
    const textCols = cols.filter(c => c.type?.toLowerCase().includes('text') || c.type === '');
    for (const col of textCols) {
        try {
            const hits = db.prepare(`SELECT COUNT(*) as n FROM [${t.name}] WHERE [${col.name}] LIKE '%intent.md%'`).get();
            if (hits.n > 0) {
                console.log(`  → ${hits.n} rows with 'intent.md' in column '${col.name}'`);
                const sample = db.prepare(`SELECT * FROM [${t.name}] WHERE [${col.name}] LIKE '%intent.md%' LIMIT 3`).all();
                for (const r of sample) {
                    const preview = Object.fromEntries(
                        Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v])
                    );
                    console.log('    ', JSON.stringify(preview));
                }
            }
        } catch {}
    }
}

db.close();
