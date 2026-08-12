import json, sqlite3, os

csdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\conversation-search.db')
con = sqlite3.connect(csdb)
cur = con.cursor()

cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print(f'Tables: {tables}')

for t in tables:
    cur.execute(f'SELECT COUNT(*) FROM "{t}"')
    count = cur.fetchone()[0]
    print(f'\n=== {t}: {count} rows ===')
    
    cur.execute(f'PRAGMA table_info("{t}")')
    cols = cur.fetchall()
    print(f'Columns:')
    for c in cols:
        print(f'  {c}')
    
    if count > 0:
        cur.execute(f'SELECT * FROM "{t}" LIMIT 3')
        rows = cur.fetchall()
        for r in rows:
            print(f'  row: {r}')

con.close()