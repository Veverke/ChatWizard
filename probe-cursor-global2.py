"""Probe the new Cursor storage format — composerHeaders table and composer.content keys."""
import json
import sqlite3
import os

db = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(db)
cur = con.cursor()

# ── composerHeaders table: full dump ──────────────────────────────────────
print('=== composerHeaders table (all rows) ===')
cur.execute('SELECT * FROM composerHeaders ORDER BY lastUpdatedAt DESC')
cols = [d[0] for d in cur.description]
for row in cur.fetchall():
    d = dict(zip(cols, row))
    print(f'\ncomposerId={d["composerId"]}')
    print(f'  workspaceId={d["workspaceId"]}')
    print(f'  createdAt={d["createdAt"]} lastUpdatedAt={d["lastUpdatedAt"]}')
    print(f'  isArchived={d["isArchived"]} isSubagent={d["isSubagent"]}')
    print(f'  recency={d["recency"]} checkpointAt={d["checkpointAt"]}')
    val = d["value"]
    try:
        v = json.loads(val)
        print(f'  value keys: {sorted(v.keys())[:30]}')
        print(f'  value _v: {v.get("_v")}')
        print(f'  value name: {v.get("name")!r}')
        print(f'  value type: {v.get("type")!r}')
        print(f'  value model: {v.get("model")!r}')
        print(f'  value branches: {len(v.get("branches", []))}')
        for k in ['conversation', 'messages', 'conversationMap', 'conversationState', 'contentHashes']:
            if k in v:
                vv = v[k]
                if isinstance(vv, str) and len(vv) > 100:
                    print(f'  {k}: <{len(vv)} chars>')
                elif isinstance(vv, (list, dict)):
                    print(f'  {k}: {json.dumps(vv)[:200]}')
                else:
                    print(f'  {k}: {vv!r}')
    except Exception as e:
        print(f'  value: (parse error: {e}) {val[:200]}')

# ── composer.content keys: sample values ─────────────────────────────────
print('\n\n=== composer.content keys (sample) ===')
cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composer.content.%' LIMIT 5")
for key, val in cur.fetchall():
    print(f'\n--- {key} (len={len(val)}) ---')
    try:
        v = json.loads(val)
        print(f'  type={type(v).__name__}')
        if isinstance(v, dict):
            print(f'  keys: {sorted(v.keys())[:20]}')
            for k in ['role', 'content', 'text', 'type', 'parts', 'messages']:
                if k in v:
                    vv = v[k]
                    s = str(vv)
                    print(f'  {k}: {s[:300]}')
        elif isinstance(v, list):
            print(f'  len: {len(v)}')
            if v:
                first = v[0]
                if isinstance(first, dict):
                    print(f'  [0] keys: {sorted(first.keys())[:20]}')
                    print(f'  [0] role: {first.get("role")!r}')
                    print(f'  [0] content: {str(first.get("content"))[:200]!r}')
    except Exception as e:
        print(f'  parse error: {e}')

# ── agentKv:blob ────────────────────────────────────────────────────────
print('\n\n=== agentKv:blob (sample) ===')
cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%' LIMIT 5")
for key, val in cur.fetchall():
    print(f'\n--- {key} (len={len(val)}) ---')
    try:
        v = json.loads(val)
        print(f'  type={type(v).__name__}')
        if isinstance(v, dict):
            print(f'  keys: {sorted(v.keys())[:20]}')
            for k in ['role', 'content', 'text', 'type']:
                if k in v:
                    vv = v[k]
                    s = str(vv)
                    print(f'  {k}: {s[:300]}')
        elif isinstance(v, list):
            print(f'  len: {len(v)}')
            if v:
                print(f'  [0]: {str(v[0])[:300]}')
    except Exception as e:
        print(f'  parse error: {e}')

# ── Check if there are composerData rows with no conversationState ──────
print('\n\n=== composerData rows with conversationState = ~ (empty/stub) ===')
cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
for key, val in cur.fetchall():
    try:
        d = json.loads(val)
        cs = d.get('conversationState', 'MISSING')
        if cs == '~' or cs == '' or cs is None:
            name = d.get('name', '')
            cid = d.get('composerId', key)
            conv = d.get('conversation')
            msgs = d.get('messages')
            headers = d.get('fullConversationHeadersOnly', [])
            bubbleMap = d.get('conversationMap', {})
            contentHashes = d.get('contentHashes')
            print(f'  {key}: name={name!r} headers={len(headers)} conv={len(conv) if conv else 0} msgs={len(msgs) if msgs else 0} bubbleMap={len(bubbleMap)} contentHashes={bool(contentHashes)}')
            # Check if this composerId has content keys
            hash_key = f'composer.content.{cid}'
            cur.execute("SELECT COUNT(*) FROM cursorDiskKV WHERE key=?", (hash_key,))
            cnt = cur.fetchone()[0]
            if cnt > 0:
                print(f'    -> has composer.content.{cid} entry!')
    except:
        pass

# ── Check composerData rows that have conversationState (old style) ────
print('\n\n=== composerData rows with REAL conversationState (has content) ===')
cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
for key, val in cur.fetchall():
    try:
        d = json.loads(val)
        cs = d.get('conversationState')
        if cs and cs != '~' and len(cs) > 5:
            name = d.get('name', '')
            print(f'  {key}: name={name!r} conversationState len={len(cs)}')
    except:
        pass

# ── Check workspace DBs for the same pattern ────────────────────────────
print('\n\n=== workspace DB check ===')
ws_root = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage')
for entry in os.listdir(ws_root):
    vscdb = os.path.join(ws_root, entry, 'state.vscdb')
    if os.path.exists(vscdb):
        try:
            wcon = sqlite3.connect(vscdb)
            wcur = wcon.cursor()
            wcur.execute("SELECT name FROM sqlite_master WHERE type='table'")
            wtables = [r[0] for r in wcur.fetchall()]
            info = []
            if 'cursorDiskKV' in wtables:
                wcur.execute("SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
                wcnt = wcur.fetchone()[0]
                if wcnt > 0:
                    info.append(f'composerData={wcnt}')
            if 'composerHeaders' in wtables:
                wcur.execute('SELECT COUNT(*) FROM composerHeaders')
                hcnt = wcur.fetchone()[0]
                info.append(f'composerHeaders={hcnt}')
            if info:
                print(f'  {entry}: {", ".join(info)}')
            wcon.close()
        except Exception as e:
            print(f'  {entry}: error {e}')

con.close()