import json, sqlite3, os

ws_base = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage')

# Check workspace DBs for composer data
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
        
        if 'cursorDiskKV' in tables:
            cur.execute("SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
            cd_count = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")
            bub_count = cur.fetchone()[0]
            
            if cd_count > 0 or bub_count > 0:
                print(f'\n=== {entry} ({size/1024:.0f}KB) ===')
                print(f'  composerData: {cd_count}, bubbleId: {bub_count}')
                
                # Get composer data
                cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
                for k, v in cur.fetchall():
                    cid = k.split(':', 1)[1]
                    d = json.loads(v)
                    cs = d.get('conversationState', '')
                    cs_type = 'protobuf' if len(cs) > 5 else ('stub(~)' if cs == '~' else 'none')
                    name = d.get('name', '') or '(unnamed)'
                    hdrs = len(d.get('fullConversationHeadersOnly', []))
                    print(f'    {cid[:20]}... name={name[:25]:25s} cs={cs_type:12s} headers={hdrs}')
                    
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
                            print(f'      bubble {bid[:12]}... type={bt} text_len={len(text)} rt_len={len(rt)}')
        
        if 'composerHeaders' in tables:
            cur.execute("SELECT COUNT(*) FROM composerHeaders")
            ch_count = cur.fetchone()[0]
            if ch_count > 0:
                cur.execute("SELECT composerId, lastUpdatedAt FROM composerHeaders ORDER BY lastUpdatedAt DESC LIMIT 5")
                print(f'  composerHeaders ({ch_count}):')
                for cid, updated in cur.fetchall():
                    print(f'    {cid[:20]}... updated={updated}')
        
        con.close()
    except Exception as e:
        print(f'  {entry}: error - {e}')