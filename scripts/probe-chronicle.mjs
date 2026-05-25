import { DatabaseSync } from 'node:sqlite';

const dbPath = 'C:/Users/ay250177/AppData/Roaming/Code - Insiders/User/globalStorage/GitHub.copilot-chat/session-store.db';

const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
console.log('TABLES:', tables.map(t => t.name).join(', '));
console.log('');

for (const { name, sql } of tables) {
    const cols = db.prepare(`PRAGMA table_info([${name}])`).all();
    const cnt  = db.prepare(`SELECT COUNT(*) as n FROM [${name}]`).get();
    console.log(`${name} (${cnt.n} rows): ${cols.map(c => c.name).join(', ')}`);

    // Sample one row to see actual data
    const sample = db.prepare(`SELECT * FROM [${name}] LIMIT 1`).get();
    if (sample) {
        const preview = {};
        for (const [k, v] of Object.entries(sample)) {
            preview[k] = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v;
        }
        console.log('  sample:', JSON.stringify(preview));
    }
    console.log('');
}

db.close();
