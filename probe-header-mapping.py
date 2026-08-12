import sqlite3
import json
import base64

global_path = r'C:\Users\avrei\AppData\Roaming\Cursor\User\globalStorage\state.vscdb'
con = sqlite3.connect(global_path)
cur = con.cursor()

row = cur.execute("SELECT value FROM cursorDiskKV WHERE key='composerData:7bf8dfc7-73a3-4317-b947-95b9dbaca511'").fetchone()
data = json.loads(row[0])

# Parse conversationState protobuf
cs = data.get('conversationState')
decoded = base64.b64decode(cs)
blob_hashes = []
offset = 0
while offset < len(decoded):
    tag = decoded[offset]
    if tag & 7 != 2:
        break
    offset += 1
    length = 0
    shift = 0
    while offset < len(decoded):
        byte = decoded[offset]
        length |= (byte & 0x7f) << shift
        shift += 7
        offset += 1
        if not (byte & 0x80):
            break
    if length == 32:
        blob_hashes.append(decoded[offset:offset+32].hex())
    offset += length

# Check the last blob that failed
print(f"=== Last blob (index 77) ===")
bh = blob_hashes[77] if len(blob_hashes) > 77 else None
if bh:
    blob_key = f'agentKv:blob:{bh}'
    blob_row = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", (blob_key,)).fetchone()
    if blob_row:
        blob_val = blob_row[0]
        print(f"type={type(blob_val).__name__}, len={len(blob_val)}")
        if isinstance(blob_val, bytes):
            print(f"First 4 bytes hex: {blob_val[:4].hex()}")
            print(f"First 200: {blob_val[:200]}")
            # Try with different parsing
            try:
                obj = json.loads(blob_val)
                print(f"Actually JSON: {json.dumps(obj)[:300]}")
            except:
                print(f"Not JSON")
                # Maybe it's a truncated/corrupt blob
                try:
                    obj = json.loads(blob_val + b'}')
                    print(f"With +}}: {json.dumps(obj)[:300]}")
                except:
                    pass
                # Try to see if there's valid JSON in the first part
                try:
                    idx = blob_val.find(b'"role"')
                    if idx >= 0:
                        print(f"Found 'role' at offset {idx}")
                        print(f"Context: {blob_val[max(0,idx-20):idx+200]}")
                except:
                    pass

# Check the fullConversationHeadersOnly mapping
print(f"\n=== fullConversationHeadersOnly count: {len(data.get('fullConversationHeadersOnly', []))} ===")
headers = data.get('fullConversationHeadersOnly', [])
for i, h in enumerate(headers):
    # Check if this header has a bubbleId that maps to anything
    bid = h.get('bubbleId', '')
    btype = h.get('type', 0)
    brow = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", (f'bubbleId:7bf8dfc7-73a3-4317-b947-95b9dbaca511:{bid}',)).fetchone()
    if brow:
        bval = json.loads(brow[0])
        req = bval.get('requestId', '')
        text = bval.get('text', '')
        print(f"  header[{i}] type={btype} bubbleId={bid[:12]}... requestId={req[:20] if req else 'N/A'} text='{text[:30]}'")
    else:
        print(f"  header[{i}] type={btype} bubbleId={bid[:12]}... MISSING")

con.close()