"""Probe: check workspace DB for composer data keys."""
import sqlite3, os, json

ws = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage\8cb3f87bbae175605b6e1fd08a5891ec\state.vscdb')
con = sqlite3.connect(ws)
cur = con.cursor()

cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print('Tables:', [r[0] for r in cur.fetchall()])

# Check ItemTable for composer/cursor/aiService keys
cur.execute("SELECT key, length(value) FROM ItemTable WHERE key LIKE '%composer%' OR key LIKE '%cursor%' OR key LIKE '%aiService%' ORDER BY key")
rows = cur.fetchall()
print(f'\nComposer/cursor/aiService keys: {len(rows)}')
for r in rows:
    print(f'  {r[0][:90]:<90} {r[1]}B')

# Check cursorDiskKV
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
if cur.fetchone():
    cur.execute("SELECT COUNT(*) FROM cursorDiskKV")
    print(f'\ncursorDiskKV rows: {cur.fetchone()[0]}')
    cur.execute("SELECT key, length(value) FROM cursorDiskKV LIMIT 20")
    for r in cur.fetchall():
        print(f'  {r[0][:90]:<90} {r[1]}B')
else:
    print('\ncursorDiskKV table does not exist')

# Check composerHeaders
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='composerHeaders'")
if cur.fetchone():
    cur.execute("SELECT COUNT(*) FROM composerHeaders")
    print(f'\ncomposerHeaders rows: {cur.fetchone()[0]}')
    cur.execute("SELECT composerId, workspaceId, createdAt, lastUpdatedAt FROM composerHeaders ORDER BY lastUpdatedAt DESC")
    for r in cur.fetchall():
        print(f'  {str(r[0])[:40]:<42} ws={str(r[1])[:20]:<22} created={r[2]} updated={r[3]}')

con.close()