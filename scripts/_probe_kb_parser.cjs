const { parseCursorGlobalDb } = require('./out/src/parsers/cursor.js');
const path = require('path');

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
parseCursorGlobalDb(dbPath).then(results => {
    const kb = results.find(r => r.session.id.startsWith('7bf8dfc7'));
    if (kb) {
        console.log('KB session:', kb.session.title, 'messages:', kb.session.messages.length);
        for (const m of kb.session.messages) {
            console.log(`  [${m.role}] ${(m.content||'').slice(0,120).replace(/\n/g, ' ')}`);
        }
    } else {
        console.log('KB session NOT found in results');
        console.log('Total sessions:', results.length);
        for (const r of results) {
            console.log(`  ${r.session.id.slice(0,8)}: '${r.session.title}' msgs=${r.session.messages.length}`);
        }
    }
});