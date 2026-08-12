import sqlite3, json, os

db_path = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Check composerData rows
cd_rows = conn.execute(
    "SELECT key, length(value) as vlen, substr(value, 1, 300) as preview FROM cursorDiskKV WHERE key LIKE ? ORDER BY key",
    ('composerData:%',)
).fetchall()
print(f'composerData rows: {len(cd_rows)}')
for r in cd_rows:
    print(f'  {r["key"]}: {r["vlen"]} bytes')
    preview = r['preview']
    print(f'    preview: {preview[:200]}')

# Check bubbleId rows
bubble_rows = conn.execute(
    "SELECT key, length(value) as vlen FROM cursorDiskKV WHERE key LIKE ? ORDER BY key",
    ('bubbleId:%',)
).fetchall()
print(f'\nbubbleId rows: {len(bubble_rows)}')
for r in bubble_rows[:5]:
    print(f'  {r["key"]}: {r["vlen"]} bytes')
print(f'  ... ({len(bubble_rows)} total)')

# Check agentKv:blob rows
blob_rows = conn.execute(
    "SELECT key, length(value) as vlen FROM cursorDiskKV WHERE key LIKE ? ORDER BY key",
    ('agentKv:blob:%',)
).fetchall()
print(f'\nagentKv:blob rows: {len(blob_rows)}')
for r in blob_rows[:3]:
    print(f'  {r["key"]}: {r["vlen"]} bytes')
print(f'  ... ({len(blob_rows)} total)')

conn.close()
