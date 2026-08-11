import json, sqlite3, os

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Check cb24daa0 user bubble content
cur.execute("SELECT value FROM cursorDiskKV WHERE key = 'bubbleId:cb24daa0-866a-437f-9c75-913d8b0271d9:520b74e7-7d8a-49f2-bc65-d487cbb6f54d'")
val = cur.fetchone()[0]
d = json.loads(val)
print('=== cb24daa0 user bubble ===')
print(f'type: {d.get("type")}')
print(f'text ({len(d.get("text",""))} bytes): {d.get("text","")!r}')
print(f'richText ({len(d.get("richText",""))} bytes): present')

# Extract Lexical text from richText
rt = d.get('richText', '')
if rt:
    rtj = json.loads(rt)
    def extract(node):
        t = ''
        if 'children' in node:
            for c in node['children']:
                t += extract(c)
        if 'text' in node:
            t += node['text']
        if node.get('type') == 'linebreak':
            t += '\n'
        return t
    extracted = extract(rtj.get('root', {}))
    print(f'\nExtracted from richText ({len(extracted)} chars):')
    print(extracted[:500])
    print('...')

# Check assistant bubble
cur.execute("SELECT value FROM cursorDiskKV WHERE key = 'bubbleId:cb24daa0-866a-437f-9c75-913d8b0271d9:d50ddadb-e50f-45ca-8d98-d34da9b2a3ae'")
val = cur.fetchone()[0]
d = json.loads(val)
print('\n=== cb24daa0 assistant bubble ===')
print(f'type: {d.get("type")}')
print(f'text ({len(d.get("text",""))} bytes): {d.get("text","")!r}')
print(f'richText ({len(d.get("richText",""))} bytes): {d.get("richText","")!r}')

# Check if there are any NEW composers that might be the recent chats
# Look at composerHeaders for the most recent ones
cur.execute("SELECT * FROM composerHeaders ORDER BY lastUpdatedAt DESC LIMIT 10")
print('\n=== Most recent composerHeaders ===')
for r in cur.fetchall():
    cid, wsid, created, updated, archived, subagent, recency, cpat, val = r
    d = json.loads(val) if val else {}
    name = d.get('name', '') or '(unnamed)'
    print(f'  {cid[:20]}... name={name[:25]:25s} updated={updated}')

# Check workspace DBs for recent Cursor chats
ws_base = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage')
print(f'\n=== Workspace DBs ===')
for entry in os.listdir(ws_base):
    ws_path = os.path.join(ws_base, entry, 'state.vscdb')
    if os.path.exists(ws_path):
        size = os.path.getsize(ws_path)
        if size > 1000:
            try:
                con2 = sqlite3.connect(ws_path)
                cur2 = con2.cursor()
                cur2.execute("SELECT name FROM sqlite_master WHERE type='table'")
                tables = [r[0] for r in cur2.fetchall()]
                has_cursor = any('cursor' in t.lower() or 'composer' in t.lower() for t in tables)
                con2.close()
                if has_cursor:
                    print(f'  {entry}: {size/1024:.0f}KB tables={tables}')
            except:
                pass

con.close()