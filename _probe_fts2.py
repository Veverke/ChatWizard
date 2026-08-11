import json, sqlite3, os

csdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\conversation-search.db')
con = sqlite3.connect(csdb)
cur = con.cursor()

# Get all conversations with body content
cur.execute("SELECT c.id, c.title, length(f.c1) as body_len, c.updated_at FROM conversations c LEFT JOIN conversation_fts_content f ON c.fts_rowid = f.id ORDER BY c.updated_at DESC")
rows = cur.fetchall()
print('Conversations with body length:')
for r in rows:
    cid, title, body_len, updated_at = r
    title_short = (title or '(unnamed)')[:35]
    print(f'  {str(cid)[:36]:<38} {title_short:<37} body={body_len:<6} updated={updated_at}')

# Check which ones have body content but are NOT in cursorDiskKV
print('\n=== Conversations with body NOT in cursorDiskKV ===')
gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con2 = sqlite3.connect(gdb)
cur2 = con2.cursor()

cur.execute("SELECT c.id, c.title, length(f.c1) as body_len FROM conversations c LEFT JOIN conversation_fts_content f ON c.fts_rowid = f.id WHERE length(f.c1) > 0")
for r in cur.fetchall():
    cid, title, body_len = r
    cur2.execute("SELECT 1 FROM cursorDiskKV WHERE key = ?", (f'composerData:{cid}',))
    if not cur2.fetchone():
        print(f'  {cid}: title={title} body_len={body_len}')

con2.close()
con.close()