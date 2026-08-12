import json, sqlite3, os

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Check composer.content keys - what format?
cur.execute("SELECT key, length(value) FROM cursorDiskKV WHERE key LIKE 'composer.content.%' LIMIT 5")
rows = cur.fetchall()
print('=== composer.content.* samples ===')
for k, vlen in rows:
    cur2 = con.cursor()
    cur2.execute("SELECT value FROM cursorDiskKV WHERE key = ?", (k,))
    val = cur2.fetchone()[0]
    cur2.close()
    preview = val[:500] if isinstance(val, str) else str(val[:200])
    print(f'  {k[:60]}... ({vlen} bytes): {preview}')
    print()

# Check ofsContent keys
cur.execute("SELECT key, length(value) FROM cursorDiskKV WHERE key LIKE 'ofsContent:%' LIMIT 5")
rows = cur.fetchall()
print('=== ofsContent.* samples ===')
for k, vlen in rows:
    cur2 = con.cursor()
    cur2.execute("SELECT value FROM cursorDiskKV WHERE key = ?", (k,))
    val = cur2.fetchone()[0]
    cur2.close()
    preview = val[:500] if isinstance(val, str) else str(val[:200])
    print(f'  {k[:60]}... ({vlen} bytes): {preview}')
    print()

# Check composerHeaders table
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='composerHeaders'")
if cur.fetchone():
    cur.execute("PRAGMA table_info(composerHeaders)")
    cols = cur.fetchall()
    print('=== composerHeaders columns ===')
    for c in cols:
        print(f'  {c}')
    cur.execute("SELECT * FROM composerHeaders LIMIT 3")
    for r in cur.fetchall():
        print(f'  row: {r}')

con.close()