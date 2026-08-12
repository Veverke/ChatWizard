import json, sqlite3, os

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Check tables
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print('Tables:', tables)

# Check cursorDiskKV key prefixes
cur.execute("SELECT DISTINCT substr(key, 1, instr(key || ':', ':') - 1) AS prefix, COUNT(*) as cnt FROM cursorDiskKV GROUP BY prefix ORDER BY cnt DESC")
prefixes = cur.fetchall()
print('\nKey prefixes:')
for p, c in prefixes:
    print(f'  {p}: {c}')

# Check composerHeaders table
if 'composerHeaders' in tables:
    cur.execute("SELECT COUNT(*) FROM composerHeaders")
    print(f'\ncomposerHeaders rows: {cur.fetchone()[0]}')
    cur.execute("SELECT key FROM composerHeaders LIMIT 5")
    for r in cur.fetchall():
        print(f'  {r[0][:80]}')

con.close()