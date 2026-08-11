import json, sqlite3, os

csdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\conversation-search.db')
con = sqlite3.connect(csdb)
cur = con.cursor()

# Get all conversations
cur.execute("SELECT c.*, f.body FROM conversations c LEFT JOIN conversation_fts_content f ON c.fts_rowid = f.id ORDER BY c.updated_at DESC")
rows = cur.fetchall()
print(f'{"fts_rowid":<10} {"source":<10} {"id":<40} {"title":<35} {"updated_at":<20} {"body_preview":<60}')
print('-'*180)
for r in rows:
    fts_rowid, source, scope, cid, title, updated_at, is_archived, root_fp, cache_fp, body = r
    body_preview = (body or '')[:60]
    title_short = (title or '(unnamed)')[:33]
    print(f'{fts_rowid:<10} {str(source):<10} {str(cid)[:38]:<40} {title_short:<35} {str(updated_at):<20} {body_preview:<60}')

# Check if there are conversations NOT in cursorDiskKV
print('\n=== Conversations NOT in cursorDiskKV ===')
gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con2 = sqlite3.connect(gdb)
cur2 = con2.cursor()

cur.execute("SELECT id FROM conversations")
for r in cur.fetchall():
    cid = r[0]
    cur2.execute("SELECT 1 FROM cursorDiskKV WHERE key = ?", (f'composerData:{cid}',))
    if not cur2.fetchone():
        # Check composerHeaders
        cur2.execute("SELECT 1 FROM composerHeaders WHERE composerId = ?", (cid,))
        if not cur2.fetchone():
            print(f'  {cid}: NOT in cursorDiskKV or composerHeaders')

con2.close()
con.close()