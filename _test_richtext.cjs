const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true });

// Get all composerData rows
const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
console.log('ComposerData rows:', rows.length);

// For each, check if it has bubbles with richText
for (const row of rows) {
    const cid = row.key.slice('composerData:'.length);
    const meta = JSON.parse(row.value);
    const cs = meta.conversationState || '';
    const name = meta.name || '';
    
    // Get bubbles for this composer
    const stmt = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?");
    const bubbles = stmt.all('bubbleId:' + cid + ':%');
    
    let hasText = false;
    let hasRichText = false;
    let totalBubbles = 0;
    for (const b of bubbles) {
        const bd = JSON.parse(b.value);
        totalBubbles++;
        if (bd.text && bd.text.trim()) hasText = true;
        if (bd.richText && bd.richText.trim()) hasRichText = true;
    }
    
    console.log(cid.slice(0,12), 'cs_len=' + cs.length, 'name=' + (name || '(none)').slice(0,30), 
        'bubbles=' + totalBubbles, 'hasText=' + hasText, 'hasRichText=' + hasRichText);
}

db.close();