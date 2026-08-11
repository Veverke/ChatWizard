import json, sqlite3, os

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Check if there are any other tables or data we're missing
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print(f'Tables: {tables}')

# Check ItemTable for cursor-related keys
if 'ItemTable' in tables:
    cur.execute("SELECT key, length(value) FROM ItemTable WHERE key LIKE '%cursor%' OR key LIKE '%composer%' OR key LIKE '%agent%' OR key LIKE '%chat%' OR key LIKE '%aiService%'")
    rows = cur.fetchall()
    print(f'\nItemTable cursor-related keys ({len(rows)}):')
    for k, vlen in rows:
        print(f'  {k}: {vlen} bytes')

# Check for any other files in Cursor storage
cursor_storage = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage')
print(f'\n=== Files in {cursor_storage} ===')
for f in sorted(os.listdir(cursor_storage)):
    fpath = os.path.join(cursor_storage, f)
    size = os.path.getsize(fpath)
    if size > 1000:
        print(f'  {f}: {size/1024:.0f}KB')
    else:
        print(f'  {f}: {size}B')

# Check for any .db or .sqlite files
print(f'\n=== Database files ===')
for f in sorted(os.listdir(cursor_storage)):
    if f.endswith('.db') or f.endswith('.sqlite') or f.endswith('.sqlite3'):
        fpath = os.path.join(cursor_storage, f)
        print(f'  {f}: {os.path.getsize(fpath)/1024:.0f}KB')

# Check for a state.vscdb in a different location
alt_paths = [
    os.path.expandvars(r'%APPDATA%\Cursor\state.vscdb'),
    os.path.expandvars(r'%APPDATA%\Cursor\User\state.vscdb'),
    os.path.expandvars(r'%APPDATA%\Cursor\globalStorage\state.db'),
]
print(f'\n=== Alternative DB paths ===')
for p in alt_paths:
    print(f'  {p}: exists={os.path.exists(p)}')

con.close()