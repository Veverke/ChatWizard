import json, sqlite3, os

ws_base = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage')

for entry in ['1786438186197', '8cb3f87bbae175605b6e1fd08a5891ec']:
    ws_path = os.path.join(ws_base, entry, 'state.vscdb')
    if not os.path.exists(ws_path):
        continue
    con = sqlite3.connect(ws_path)
    cur = con.cursor()
    
    print(f'\n=== {entry} ===')
    
    # Check cursorDiskKV
    cur.execute("SELECT COUNT(*) FROM cursorDiskKV")
    total = cur.fetchone()[0]
    print(f'cursorDiskKV: {total} rows')
    
    if total > 0:
        cur.execute("SELECT DISTINCT substr(key, 1, instr(key || ':', ':') - 1) AS prefix, COUNT(*) as cnt FROM cursorDiskKV GROUP BY prefix ORDER BY cnt DESC")
        for p, c in cur.fetchall():
            print(f'  {p}: {c}')
        
        # Check composerData
        cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        for k, v in cur.fetchall():
            cid = k.split(':', 1)[1]
            d = json.loads(v)
            cs = d.get('conversationState', '')
            cs_type = 'protobuf' if len(cs) > 5 else ('stub(~)' if cs == '~' else 'none')
            name = d.get('name', '') or '(unnamed)'
            hdrs = len(d.get('fullConversationHeadersOnly', []))
            print(f'  composerData: {cid[:20]}... name={name[:25]:25s} cs={cs_type:12s} headers={hdrs}')
            
            # Check bubbles
            cur2 = con.cursor()
            cur2.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?", (f'bubbleId:{cid}:%',))
            bubbles = cur2.fetchall()
            cur2.close()
            if bubbles:
                for bk, bv in bubbles:
                    bd = json.loads(bv)
                    bid = bk.split(':')[-1]
                    bt = bd.get('type', '?')
                    text = bd.get('text', '')
                    rt = bd.get('richText', '')
                    print(f'    bubble {bid[:12]}... type={bt} text_len={len(text)} rt_len={len(rt)}')
    
    # Check composerHeaders
    cur.execute("SELECT COUNT(*) FROM composerHeaders")
    ch_count = cur.fetchone()[0]
    print(f'composerHeaders: {ch_count} rows')
    if ch_count > 0:
        cur.execute("SELECT composerId, lastUpdatedAt FROM composerHeaders ORDER BY lastUpdatedAt DESC LIMIT 10")
        for cid, updated in cur.fetchall():
            print(f'  {cid[:20]}... updated={updated}')
    
    con.close()