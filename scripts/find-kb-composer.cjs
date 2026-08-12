/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const db = new Database(process.env.APPDATA + '\\Cursor\\User\\globalStorage\\state.vscdb', { readonly: true });
const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
for (const r of rows) {
    const v = JSON.parse(r.value);
    if (v.name && v.name.toLowerCase().includes('knowledge')) {
        console.log('id:', r.key.slice('composerData:'.length), 'name:', v.name);
    }
}
db.close();