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
const blobs = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'").all();
const blobSet = new Set(blobs.map(b => b.key.slice('agentKv:blob:'.length)));

// load all blob contents
const blobRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'").all();
const blobContent = new Map();
for (const b of blobRows) {
    const h = b.key.slice('agentKv:blob:'.length);
    const content = typeof b.value === 'string' ? b.value : b.value.toString('utf-8');
    blobContent.set(h, content);
}
db.close();

console.log('composers:', metas.length, 'blobs:', blobs.length);

for (const m of metas) {
    const id = m.key.slice('composerData:'.length);
    let meta;
    try { meta = JSON.parse(m.value); } catch { console.log(id.slice(0,8), 'BAD META'); continue; }
    const cs = typeof meta.conversationState === 'string' ? meta.conversationState : undefined;
    const hashes = cs ? parseCS(cs) : [];
    const found = hashes.filter(h => blobSet.has(h));
    // count roles among found blobs
    let user = 0, asst = 0, other = 0, parseErr = 0;
    for (const h of found) {
        const raw = blobContent.get(h);
        if (!raw) continue;
        try {
            const j = JSON.parse(raw);
            if (j.role === 'user') user++;
            else if (j.role === 'assistant') asst++;
            else other++;
        } catch { parseErr++; }
    }
    console.log(JSON.stringify({
        id: id.slice(0,8),
        title: (meta.name || '').slice(0, 45),
        hashes: hashes.length,
        foundInBlobs: found.length,
        user, asst, other, parseErr
    }));
}