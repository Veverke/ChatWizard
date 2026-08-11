import json
import sqlite3
import os
import sys

global_db = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
print(f'Global DB exists: {os.path.exists(global_db)}')
print(f'Global DB size: {os.path.getsize(global_db) if os.path.exists(global_db) else 0} bytes')

if not os.path.exists(global_db):
    sys.exit(0)

con = sqlite3.connect(global_db)
cur = con.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print(f'Tables: {tables}')

if 'cursorDiskKV' in tables:
    cur.execute('SELECT COUNT(*) FROM cursorDiskKV')
    total = cur.fetchone()[0]
    print(f'Total rows: {total}')

    cur.execute("SELECT DISTINCT CASE WHEN instr(key, ':') > 0 THEN substr(key, 1, instr(key, ':') - 1) ELSE key END AS pfx FROM cursorDiskKV ORDER BY pfx")
    prefixes = [r[0] for r in cur.fetchall()]
    print(f'Prefixes: {prefixes}')
    for p in prefixes:
        cur.execute("SELECT COUNT(*) FROM cursorDiskKV WHERE CASE WHEN instr(key, ':') > 0 THEN substr(key, 1, instr(key, ':') - 1) ELSE key END = ?", (p,))
        print(f'  {p}: {cur.fetchone()[0]} rows')

    # Sample composer data
    cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 10")
    for r in cur.fetchall():
        key, val = r
        try:
            d = json.loads(val)
        except Exception as e:
            print(f'{key}: parse error {e}')
            continue
        cid = d.get('composerId', '')
        name = d.get('name', '')
        ctype = d.get('type', '')
        created = d.get('createdAt', '')
        updated = d.get('lastUpdatedAt', '')
        branch = d.get('activeBranch', {})
        lai = branch.get('lastInteractionAt', '') if isinstance(branch, dict) else ''
        print(f'\n  {key}')
        print(f'    composerId={cid} name={name!r} type={ctype}')
        print(f'    createdAt={created} lastUpdatedAt={updated} lastInteractionAt={lai}')
        print(f'    has conversationState: {"conversationState" in d}')
        print(f'    has conversation: {"conversation" in d}')
        print(f'    has messages: {"messages" in d}')
        cs = d.get('conversationState')
        if cs:
            print(f'    conversationState len={len(cs)}')
        conv = d.get('conversation') or d.get('messages')
        if conv and isinstance(conv, list):
            print(f'    conversation items: {len(conv)}')
            if conv:
                first = conv[0]
                if isinstance(first, dict):
                    print(f'    first item keys: {sorted(first.keys())[:20]}')
                    print(f'    first item text: {str(first.get("text") or first.get("content") or "")[:100]!r}')

con.close()