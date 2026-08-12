/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path');
const m = require(path.join(__dirname, '..', 'out', 'parsers', 'cursor.js'));
const globalDb = process.env.APPDATA + '\\Cursor\\User\\globalStorage\\state.vscdb';

m.parseCursorGlobalDb(globalDb).then(results => {
    const withMsgs = results.filter(r => r.session.messages.length > 0);
    for (const r of withMsgs) {
        console.log(r.session.title, '| msgs:', r.session.messages.length, '| id:', r.session.id.slice(0, 12));
    }
    console.log('\nTotal sessions with messages:', withMsgs.length);
    console.log('Total sessions (all):', results.length);
    
    // Find KB session
    const kb = results.find(r => r.session.id === '7bf8dfc7-73a3-4317-b947-95b9dbaca511');
    if (kb) {
        console.log('\n=== KB Session ===');
        console.log('Title:', kb.session.title);
        console.log('Messages:', kb.session.messages.length);
        kb.session.messages.forEach((m, i) => {
            console.log(`  [${i}] role=${m.role} content_len=${m.content.length} timestamp=${m.timestamp || 'none'}`);
        });
    } else {
        console.log('\nKB session not found in results');
    }
}).catch(err => {
    console.error('Error:', err);
});