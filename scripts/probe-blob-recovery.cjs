/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const db = new Database(process.env.APPDATA + '\\Cursor\\User\\globalStorage\\state.vscdb', { readonly: true });

const composerId = '7bf8dfc7-73a3-4317-b947-95b9dbaca511';

const compRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = 'composerData:" + composerId + "'").get();
const comp = JSON.parse(compRow.value);
console.log('conversationState exists:', typeof comp.conversationState === 'string');
console.log('conversationState length:', typeof comp.conversationState === 'string' ? comp.conversationState.length : 0);

// Parse conversationState protobuf
const decoded = Buffer.from(comp.conversationState, 'base64');
console.log('decoded length:', decoded.length);
console.log('first 60 bytes hex:', decoded.toString('hex').slice(0, 120));

let offset = 0;
const hashes = [];
while (offset < decoded.length) {
    const tag = decoded[offset];
    const wireType = tag & 7;
    const fieldNum = tag >> 3;
    if (wireType !== 2 && wireType !== 0) {
        console.log('UNEXPECTED wireType', wireType, 'at field', fieldNum, 'offset', offset);
        break;
    }
    if (wireType === 0) {
        offset++;
        let val = 0;
        let shift = 0;
        while (offset < decoded.length) {
            const byte = decoded[offset];
            val |= (byte & 0x7f) << shift;
            shift += 7;
            offset++;
            if (!(byte & 0x80)) break;
        }
        console.log('field', fieldNum, 'varint value:', val);
        continue;
    }
    offset++;
    let len = 0;
    let shift = 0;
    while (offset < decoded.length) {
        const byte = decoded[offset];
        len |= (byte & 0x7f) << shift;
        shift += 7;
        offset++;
        if (!(byte & 0x80)) break;
    }
    if (len === 32) {
        hashes.push(decoded.slice(offset, offset + 32).toString('hex'));
    } else {
        console.log('field', fieldNum, 'non-32 len', len, 'content:', decoded.slice(offset, offset + len).toString('utf-8').slice(0, 120));
    }
    offset += len;
}
console.log('total hashes:', hashes.length);

// roles in blobs
let userCount = 0, assistantCount = 0, otherCount = 0, missingCount = 0;
const roleSamples = { user: [], assistant: [], other: [] };
for (const hash of hashes) {
    const blobRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = 'agentKv:blob:" + hash + "'").get();
    if (!blobRow) { missingCount++; continue; }
    const content = blobRow.value.toString('utf-8');
    let parsed;
    try { parsed = JSON.parse(content); } catch (e) { otherCount++; continue; }
    const role = parsed.role;
    if (role === 'user') { userCount++; roleSamples.user.push(parsed); }
    else if (role === 'assistant') { assistantCount++; roleSamples.assistant.push(parsed); }
    else { otherCount++; roleSamples.other.push(parsed); }
}
console.log('user blobs:', userCount, 'assistant blobs:', assistantCount, 'other:', otherCount, 'missing:', missingCount);

function preview(parsed, label) {
    const c = parsed.content;
    const typeStr = typeof c === 'string' ? 'string' : Array.isArray(c) ? 'array:' + c.length : typeof c;
    const previewStr = typeof c === 'string' ? c.slice(0, 120) : JSON.stringify(c).slice(0, 120);
    console.log(`  [${label}] role=${parsed.role} content(${typeStr}) = ${previewStr}`);
}

console.log('\n=== user blobs ===');
roleSamples.user.forEach((p, i) => preview(p, i));
console.log('\n=== assistant blobs ===');
roleSamples.assistant.forEach((p, i) => preview(p, i));
console.log('\n=== other blobs ===');
roleSamples.other.forEach((p, i) => preview(p, i));

db.close();