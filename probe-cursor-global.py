import sqlite3
import json

global_path = r'C:\Users\avrei\AppData\Roaming\Cursor\User\globalStorage\state.vscdb'
con = sqlite3.connect(global_path)
cur = con.cursor()

row = cur.execute("SELECT value FROM cursorDiskKV WHERE key='composerData:7bf8dfc7-73a3-4317-b947-95b9dbaca511'").fetchone()
if row:
    data = json.loads(row[0])
    
    print("=== conversationMap ===")
    cm = data.get('conversationMap')
    if cm:
        print(f"type: {type(cm).__name__}")
        if isinstance(cm, dict):
            print(f"keys count: {len(cm)}")
            for k, v in list(cm.items())[:10]:
                print(f"  {k}: {json.dumps(v)[:300] if v else 'None'}")
        elif isinstance(cm, list):
            print(f"len: {len(cm)}")
            for v in cm[:5]:
                print(f"  {json.dumps(v)[:300]}")
    else:
        print("None")
    
    print("\n=== conversationState ===")
    cs = data.get('conversationState')
    if cs:
        print(f"type: {type(cs).__name__}")
        print(json.dumps(cs)[:1500])
    else:
        print("None")
    
    print("\n=== queueItems ===")
    qi = data.get('queueItems')
    if qi:
        print(f"type: {type(qi).__name__}, len: {len(qi) if isinstance(qi, list) else 'N/A'}")
        if isinstance(qi, list) and len(qi) > 0:
            print(json.dumps(qi[0])[:800])
    else:
        print("None")
    
    print("\n=== conversationCheckpointLastUpdatedAt ===")
    print(data.get('conversationCheckpointLastUpdatedAt'))
    
    print("\n=== latestChatGenerationUUID ===")
    print(data.get('latestChatGenerationUUID'))
    
    print("\n=== blobEncryptionKey ===")
    print(str(data.get('blobEncryptionKey'))[:100])

    # Check the last few header bubbles and their content
    print("\n=== Last 5 bubbles content ===")
    headers = data.get('fullConversationHeadersOnly', [])
    for h in headers[-5:]:
        bid = h.get('bubbleId')
        btype = h.get('type')
        brow = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", (f'bubbleId:7bf8dfc7-73a3-4317-b947-95b9dbaca511:{bid}',)).fetchone()
        if brow:
            bval = json.loads(brow[0])
            text = bval.get('text', '')
            rt = bval.get('richText', '')
            req = bval.get('requestId', '')
            print(f"\n  bubble {bid} type={btype}")
            print(f"    text: '{text[:100]}'")
            print(f"    richText: '{rt[:150]}'")
            print(f"    requestId: {req}")
            # Check contextPieces
            cp = bval.get('contextPieces', [])
            if cp:
                print(f"    contextPieces: {len(cp)}")
                if isinstance(cp[0], dict):
                    print(f"    first cp keys: {list(cp[0].keys())[:15]}")
                    for f in ['text', 'content', 'richText', 'type', 'uri', 'path', 'filePath']:
                        if f in cp[0] and cp[0][f]:
                            print(f"    cp.{f}: {str(cp[0][f])[:200]}")

con.close()