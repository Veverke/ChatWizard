import sqlite3
import json
import base64
import zlib
import gzip
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

global_path = r'C:\Users\avrei\AppData\Roaming\Cursor\User\globalStorage\state.vscdb'
con = sqlite3.connect(global_path)
cur = con.cursor()

row = cur.execute("SELECT value FROM cursorDiskKV WHERE key='composerData:7bf8dfc7-73a3-4317-b947-95b9dbaca511'").fetchone()
data = json.loads(row[0])

key_bytes = base64.b64decode(data.get('blobEncryptionKey'))

# Get the conversationState blob list
cs = data.get('conversationState')
decoded = base64.b64decode(cs)

# Parse protobuf repeated field 1 (wire type 2, each is 32 bytes)
blob_hashes = []
offset = 0
while offset < len(decoded):
    tag = decoded[offset]
    fn = tag >> 3
    wt = tag & 7
    if wt != 2:
        break
    offset += 1
    # Read varint length
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
        blob_hash = decoded[offset:offset+32].hex()
        blob_hashes.append(blob_hash)
    offset += length

print(f"Total blob hashes in conversationState: {len(blob_hashes)}")

# Now try to decrypt the blob entries
# First, let's look at the actual blob content structure
print("\n=== Blob structure analysis ===")
for bh in blob_hashes[:5]:
    blob_key = f'agentKv:blob:{bh}'
    blob_row = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", (blob_key,)).fetchone()
    if blob_row:
        blob_val = blob_row[0]
        print(f"\nBlob {bh[:20]}... type={type(blob_val).__name__}, len={len(blob_val)}")
        if isinstance(blob_val, bytes):
            print(f"  First 4 bytes: {blob_val[:4].hex()}")
            print(f"  First 50 as hex: {blob_val[:50].hex()}")
            # Check if it's protobuf-like
            if blob_val[0] in [0x0a, 0x08, 0x12, 0x0a, 0x0b]:
                print(f"  Protobuf-like (tag={blob_val[0]:02x}, fn={blob_val[0]>>3})")
        elif isinstance(blob_val, str):
            print(f"  First 100: {blob_val[:100]}")

# The blob content for the 3rd hash (70eba6c9...) was plain JSON
# Let's read it fully
print("\n\n=== Plaintext blob (70eba6c9...) ===")
blob_row = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", ('agentKv:blob:70eba6c95d4c5a2fd021834e2fa29501a26652821c4dea12b080d5b55952f5e1',)).fetchone()
if blob_row:
    blob_val = blob_row[0]
    if isinstance(blob_val, bytes):
        print(f"Bytes, len={len(blob_val)}")
        print(f"First 500: {blob_val[:500]}")
    elif isinstance(blob_val, str):
        print(f"String, len={len(blob_val)}")
        print(f"First 500: {blob_val[:500]}")

# Dump all 78 blobs' structure
print("\n\n=== All blobs in conversationState order ===")
for i, bh in enumerate(blob_hashes):
    blob_key = f'agentKv:blob:{bh}'
    blob_row = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", (blob_key,)).fetchone()
    if not blob_row:
        print(f"  [{i}] {bh[:16]}... MISSING")
        continue
    blob_val = blob_row[0]
    if isinstance(blob_val, bytes):
        # Check if JSON
        try:
            obj = json.loads(blob_val)
            role = obj.get('role', '?')
            content = obj.get('content', '')
            # Get text preview
            preview = ''
            if isinstance(content, str):
                preview = content[:80]
            elif isinstance(content, list):
                parts = []
                for c in content[:3]:
                    if isinstance(c, dict):
                        t = c.get('text') or c.get('toolCallId') or c.get('type') or ''
                        parts.append(str(t)[:60])
                preview = ' | '.join(parts)
            print(f"  [{i}] {bh[:16]}... JSON role={role} len={len(blob_val)} :: {preview}")
        except json.JSONDecodeError:
            print(f"  [{i}] {bh[:16]}... BYTES len={len(blob_val)} first4={blob_val[:4].hex()}")
    else:
        print(f"  [{i}] {bh[:16]}... STR len={len(blob_val)} :: {blob_val[:80]}")

con.close()