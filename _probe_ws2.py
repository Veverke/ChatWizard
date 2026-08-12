import json, sqlite3, os

ws_base = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage')

# Check ALL workspace DBs
for entry in sorted(os.listdir(ws_base)):
    ws_path = os.path.join(ws_base, entry, 'state.vscdb')
    if not os.path.exists(ws_path):
        continue
    size = os.path.getsize(ws_path)
    if size < 1000:
        continue
    try:
        con = sqlite3.connect(ws_path)
        cur = con.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
        print(f'{entry}: {size/1024:.0f}KB tables={tables}')
        con.close()
    except Exception as e:
        print(f'{entry}: error - {e}')