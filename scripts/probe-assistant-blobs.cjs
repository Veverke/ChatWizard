/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const db = new Database(process.env.APPDATA + '\\Cursor\\User\\globalStorage\\state.vscdb', { readonly: true });

const composerId = '7bf8dfc7-73a3-4317-b947-95b9dbaca511';
const compRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = 'composerData:" + composerId + "'").get();
const comp = JSON.parse(compRow.value);
const decoded = Buffer.from(comp.conversationState, 'base64');

// Collect all 32-byte hashes from field 1
let offset = 0;
const hashes = [];
while (offset < decoded.length) {
    const tag = decoded[offset];
    const wireType = tag & 7;
    if (wireType !== 2) break;
    offset++;
    let len = 0, shift = 0;
    while (offset < decoded.length) {
        const byte = decoded[offset];
        len |= (byte & 0x7f) << shift;
        shift += 7;
        offset++;
        if (!(byte & 0x80)) break;
    }
    if (len === 32) hashes.push(decoded.slice(offset, offset + 32).toString('hex'));
    offset += len;
}

// Print full structure of first assistant blob
let assistantShown = 0;
for (const hash of hashes) {
    const blobRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = 'agentKv:blob:" + hash + "'").get();
    if (!blobRow) continue;
    const content = blobRow.value.toString('utf-8');
    let parsed;
    try { parsed = JSON.parse(content); } catch (e) { continue; }
    if (parsed.role === 'assistant') {
        console.log('=== assistant blob', assistantShown, 'hash', hash.slice(0, 12), '===');
        console.log('content array length:', Array.isArray(parsed.content) ? parsed.content.length : 'n/a');
        if (Array.isArray(parsed.content)) {
            parsed.content.forEach((part, i) => {
                console.log(`  part[${i}] type=${part.type} keys=${Object.keys(part).join(',')}`);
                if (part.type === 'text') {
                    console.log(`    text: ${String(part.text).slice(0, 150)}`);
                } else if (part.type === 'redacted-reasoning') {
                    console.log(`    data (len ${part.data ? part.data.length : 0}): ${String(part.data).slice(0, 80)}`);
                } else {
                    console.log(`    raw: ${JSON.stringify(part).slice(0, 150)}`);
                }
            });
        }
        assistantShown++;
        if (assistantShown >= 2) break;
    }
}

// Also print the field-4 embedded assistant message
console.log('\n=== field 4 embedded assistant message ===');
offset = 0;
while (offset < decoded.length) {
    const tag = decoded[offset];
    const wireType = tag & 7;
    const fieldNum = tag >> 3;
    if (wireType !== 2) break;
    offset++;
    let len = 0, shift = 0;
    while (offset < decoded.length) {
        const byte = decoded[offset];
        len |= (byte & 0x7f) << shift;
        shift += 7;
        offset++;
        if (!(byte & 0x80)) break;
    }
    if (fieldNum === 4) {
        const raw = decoded.slice(offset, offset + len).toString('utf-8');
        console.log('field 4 raw (first 300):', raw.slice(0, 300));
        try {
            const parsed = JSON.parse(raw);
            console.log('parsed role:', parsed.role);
            if (Array.isArray(parsed.content)) {
                parsed.content.forEach((part, i) => {
                    console.log(`  part[${i}] type=${part.type}`);
                    if (part.type === 'text') console.log(`    text: ${String(part.text).slice(0, 150)}`);
                });
            }
        } catch (e) { console.log('not JSON:', e.message); }
        break;
    }
    offset += len;
}

db.close();