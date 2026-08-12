const Database = require('better-sqlite3');
const path = require('path');

function parseCS(conversationState) {
    const decoded = Buffer.from(conversationState, 'base64');
    const hashes = [];
    let offset = 0;
    while (offset < decoded.length) {
        const tag = decoded[offset];
        if ((tag & 7) !== 2) break;
        offset++;
        let length = 0, shift = 0;
        while (offset < decoded.length) {
            const byte = decoded[offset];
            length |= (byte & 0x7f) << shift;
            shift += 7;
            offset++;
            if (!(byte & 0x80)) break;
        }
        if (length === 32) hashes.push(decoded.slice(offset, offset + 32).toString('hex'));
        offset += length;
    }
    return hashes;
}

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true });
const metas = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
const blobRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'").all();
const blobContent = new Map();
for (const b of blobRows) {
    const h = b.key.slice('agentKv:blob:'.length);
    const content = typeof b.value === 'string' ? b.value : b.value.toString('utf-8');
    blobContent.set(h, content);
}
db.close();

// find KB composer
const meta = metas.find(m => m.key.includes('7bf8dfc7'));
const mm = JSON.parse(meta.value);
console.log('composer name:', mm.name, 'has conversationState:', typeof mm.conversationState === 'string');
const hashes = parseCS(mm.conversationState);
console.log('hashes:', hashes.length);

// group by role
const byRole = {};
for (const h of hashes) {
    const raw = blobContent.get(h);
    let role = 'UNPARSEABLE';
    let preview = '';
    if (raw) {
        try {
            const j = JSON.parse(raw);
            role = j.role || '(no role)' + (j.type ? ' type=' + j.type : '');
            preview = typeof j.content === 'string' ? j.content.slice(0, 80) : (Array.isArray(j.content) ? '[array len=' + j.content.length + ']' : JSON.stringify(j.content).slice(0, 80));
        } catch (e) {
            role = 'PARSE_ERROR';
            preview = raw.slice(0, 80);
        }
    } else {
        role = 'BLOB_MISSING';
    }
    if (!byRole[role]) byRole[role] = [];
    if (byRole[role].length < 8) byRole[role].push({ h: h.slice(0, 12), preview });
}
console.log('\n=== ROLE COUNTS ===');
for (const [role, items] of Object.entries(byRole)) {
    console.log(`\n[${role}] count=${hashes.filter(h => {
        const raw = blobContent.get(h);
        try { const j = JSON.parse(raw); return (j.role || '(no role)') === role; } catch { return role === 'UNPARSEABLE' || role === 'PARSE_ERROR'; }
    }).length}`);
    for (const it of items) console.log('   ', it.h, '=>', it.preview.replace(/\n/g, ' ').slice(0, 90));
}