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

print(f"Total blob hashes: {len(blob_hashes)}")

# Check each blob for JSON parseability
json_ok = 0
json_fail = 0
for i, bh in enumerate(blob_hashes):
    blob_key = f'agentKv:blob:{bh}'
    blob_row = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", (blob_key,)).fetchone()
    if not blob_row:
        print(f"  [{i}] MISSING")
        continue
    blob_val = blob_row[0]
    if isinstance(blob_val, bytes):
        try:
            obj = json.loads(blob_val)
            role = obj.get('role', '?')
            json_ok += 1
        except:
            json_fail += 1
            print(f"  [{i}] NOT JSON: first4={blob_val[:4].hex()} len={len(blob_val)}")
    else:
        json_ok += 1

print(f"\nJSON OK: {json_ok}, JSON fail: {json_fail}")

# Check if the failed blobs might be encrypted
# The blobEncryptionKey is present - try AES-GCM on the failed one
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
key_bytes = base64.b64decode(data.get('blobEncryptionKey'))

for i, bh in enumerate(blob_hashes):
    blob_key = f'agentKv:blob:{bh}'
    blob_row = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", (blob_key,)).fetchone()
    if not blob_row:
        continue
    blob_val = blob_row[0]
    if isinstance(blob_val, bytes):
        try:
            json.loads(blob_val)
            continue  # already JSON
        except:
            pass
        
        # Try AES-GCM with first 12 bytes as nonce
        if len(blob_val) >= 28:  # nonce(12) + ciphertext + tag(16)
            for nonce_len in [12, 16]:
                nonce = blob_val[:nonce_len]
                ct_and_tag = blob_val[nonce_len:]
                if len(ct_and_tag) >= 16:
                    try:
                        aesgcm = AESGCM(key_bytes)
                        plain = aesgcm.decrypt(nonce, ct_and_tag, None)
                        print(f"\n  [{i}] AES-GCM SUCCESS nonce_len={nonce_len}!")
                        print(f"    Plaintext: {plain[:200]}")
                        try:
                            obj = json.loads(plain)
                            print(f"    JSON role={obj.get('role', '?')}")
                        except:
                            print(f"    Not JSON after decrypt")
                    except:
                        pass

con.close()