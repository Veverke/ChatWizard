const Database = require('better-sqlite3');
// Configure via environment variable or replace the placeholder with a local path.
const dbPath = process.env['CW_DB_PATH']
    ?? 'C:\\Users\\<username>\\AppData\\Roaming\\Code - Insiders\\User\\globalStorage\\github.copilot-chat\\session-store.db';
const db = new Database(dbPath, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));
for (const t of tables) {
    try {
        const n = db.prepare(`SELECT COUNT(*) as n FROM "${t.name}"`).get();
        console.log(`  ${t.name}: ${n.n} rows`);
        if (n.n > 0 && n.n <= 5) {
            const rows = db.prepare(`SELECT * FROM "${t.name}" LIMIT 3`).all();
            console.log('  sample:', JSON.stringify(rows).slice(0, 500));
        }
    } catch(e) { console.log(`  ${t.name}: error - ${e.message}`); }
}
db.close();
