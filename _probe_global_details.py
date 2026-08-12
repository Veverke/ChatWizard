"""Probe: check global DB ItemTable for composer data and other chat storage."""
import sqlite3, os, json

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Check all tables
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print('Tables:', [r[0] for r in cur.fetchall()])

# Check ItemTable for composer-related keys
cur.execute("SELECT key, length(value) FROM ItemTable WHERE key LIKE '%composer%' OR key LIKE '%cursorDiskKV%' OR key LIKE '%chat%' OR key LIKE '%conversation%' ORDER BY key")
rows = cur.fetchall()
print(f'\nComposer/chat/conversation keys in ItemTable: {len(rows)}')
for r in rows:
    val_preview = ''
    if r[1] < 200:
        cur2 = con.cursor()
        cur2.execute("SELECT value FROM ItemTable WHERE key = ?", (r[0],))
        v = cur2.fetchone()
        if v:
            val_preview = f' = {str(v[0])[:120]}'
    print(f'  {r[0][:80]:<80} {r[1]}B{val_preview}')

# Check cursorDiskKV key types
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
if cur.fetchone():
    cur.execute("SELECT COUNT(*) FROM cursorDiskKV")
    total = cur.fetchone()[0]
    print(f'\ncursorDiskKV total rows: {total}')
    
    # Key prefix distribution
    cur.execute("""
        SELECT 
            CASE 
                WHEN key LIKE 'composerData:%' THEN 'composerData'
                WHEN key LIKE 'bubbleId:%' THEN 'bubbleId'
                WHEN key LIKE 'agentKv:blob:%' THEN 'agentKv:blob'
                WHEN key LIKE 'agentKv:%' THEN 'agentKv:other'
                WHEN key LIKE 'ofsContent:%' THEN 'ofsContent'
                WHEN key LIKE 'composer.content.%' THEN 'composer.content'
                WHEN key LIKE 'composer.%' THEN 'composer.other'
                ELSE SUBSTR(key, 1, 50)
            END as prefix,
            COUNT(*) as cnt,
            SUM(LENGTH(value)) as total_bytes
        FROM cursorDiskKV 
        GROUP BY prefix
        ORDER BY cnt DESC
    """)
    print('Key type distribution:')
    for r in cur.fetchall():
        print(f'  {str(r[0]):<30} {r[1]:>5} rows, {r[2]//1024 if r[2] else 0:>6} KB')
    
    # Check for any keys with recent timestamps or updated_at
    cur.execute("SELECT key, length(value) FROM cursorDiskKV WHERE key LIKE '%updated%' OR key LIKE '%created%' OR key LIKE '%timestamp%' LIMIT 20")
    ts_rows = cur.fetchall()
    if ts_rows:
        print(f'\nTimestamp-related keys: {len(ts_rows)}')
        for r in ts_rows:
            print(f'  {r[0][:80]:<80} {r[1]}B')

    # Check composerData entries for those with conversationState (protobuf) vs stub (~)
    cur.execute("SELECT key, length(value) FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
    comp_rows = cur.fetchall()
    protobuf_count = 0
    stub_count = 0
    for r in comp_rows:
        cur2 = con.cursor()
        cur2.execute("SELECT value FROM cursorDiskKV WHERE key = ?", (r[0],))
        v = cur2.fetchone()
        if v:
            try:
                parsed = json.loads(v[0])
                cs = parsed.get('conversationState', '')
                if cs and cs != '~':
                    protobuf_count += 1
                else:
                    stub_count += 1
            except:
                stub_count += 1
    print(f'\nComposerData: {protobuf_count} protobuf, {stub_count} stub')

    # Check for any composerData entries that have bubbles with actual text
    cur.execute("""
        SELECT kv.key, LENGTH(kv.value) as vlen 
        FROM cursorDiskKV kv 
        WHERE kv.key LIKE 'bubbleId:%' 
        ORDER BY vlen DESC 
        LIMIT 20
    """)
    big_bubbles = cur.fetchall()
    print(f'\nLargest bubble entries:')
    for r in big_bubbles[:10]:
        print(f'  {r[0][:70]:<70} {r[1]}B')

con.close()