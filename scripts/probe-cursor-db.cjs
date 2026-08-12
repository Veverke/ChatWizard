// probe-cursor-db.cjs
const m = require('c:\\Repos\\Personal\\ChatWizard\\node_modules\\better-sqlite3');
try {
  const db = new m('c:\\Users\\avrei\\AppData\\Roaming\\Cursor\\User\\workspaceStorage\\8cb3f87bbae175605b6e1fd08a5891ec\\state.vscdb', { readonly: true, fileMustExist: true });
  const r = db.prepare("SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'composerData:%'").get();
  console.log('Cursor DB from host Node:', JSON.stringify(r));
  db.close();
} catch(e) {
  console.log('Failed:', e.message.substring(0,200));
}