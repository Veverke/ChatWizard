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
key = base64.b64decode(data.get('blobEncryptionKey'))

# Get the blob hashes from conversationState protobuf
cs = data.get('conversationState')
decoded = base64.b64decode(cs)
blob_hashes = []
offset = 0
while offset < len(decoded):
    # Each field: tag (0x0a = field 1, wire type 2), varint length, then bytes
    if decoded[offset] != 0x0a:
        print(f"Unexpected byte at offset {offset}: {decoded[offset]:02x}")
        break
    offset += 1
    # Read varint length
    shift = 0
    length = 0
    while offset < len(decoded):
        byte = decoded[offset]
        length |= (byte & 0x7f) << shift
        shift += 7
        offset += 1
        if not (byte & 0x80):
            break
    blob_hash = decoded[offset:offset+length].hex()
    blob_hashes.append(blob_hash)
    offset += length

print(f"Total blob references in conversationState: {len(blob_hashes)}")
print(f"First 5: {blob_hashes[:5]}")
print(f"Last 5: {blob_hashes[-5:]}")

# Try to load each blob from agentKv
print("\n=== Loading blobs from agentKv ===")
blob_contents = []
for i, h in enumerate(blob_hashes):
    row = cur.execute("SELECT value FROM cursorDiskKV WHERE key=?", (f'agentKv:blob:{h}',)).fetchone()
    if row:
        blob_bytes = row[0]
        print(f"\n  Blob {i}: {h[:16]}... ({len(blob_bytes)} bytes)")
        
        # Try as plain JSON
        try:
            obj = json.loads(blob_bytes)
            print(f"    -> Plain JSON! role={obj.get('role','?')}, content keys={list(obj.keys())[:10]}")
            blob_contents.append(('plain', obj))
            continue
        except:
            pass
        
        # Try gzip
        try:
            decompressed = gzip.decompress(blob_bytes)
            try:
                obj = json.loads(decompressed)
                print(f"    -> Gzipped JSON! role={obj.get('role','?')}, keys={list(obj.keys())[:10]}")
                blob_contents.append(('plain', obj))
                continue
            except:
                print(f"    -> Gzipped (non-JSON, {len(decompressed)} bytes): {decompressed[:100]}")
                blob_contents.append(('gzip-unknown', decompressed))
                continue
        except:
            pass
        
        # Try zlib
        try:
            decompressed = zlib.decompress(blob_bytes)
            try:
                obj = json.loads(decompressed)
                print(f"    -> Zlib JSON! role={obj.get('role','?')}, keys={list(obj.keys())[:10]}")
                blob_contents.append(('plain', obj))
                continue
            except:
                print(f"    -> Zlib (non-JSON, {len(decompressed)} bytes): {decompressed[:100]}")
                blob_contents.append(('zlib-unknown', decompressed))
                continue
        except:
            pass
        
        # Try AES-256-GCM decryption
        # The encrypted blob likely has structure: nonce(ciphertext + tag)
        # or protobuf-wrapped: field1(nonce) field2(ciphertext + tag)
        for nonce_len in [12, 16]:
            # Try raw: first N bytes = nonce, rest = ciphertext+tag
            if len(blob_bytes) > nonce_len + 16:
                try:
                    aesgcm = AESGCM(key)
                    nonce = blob_bytes[:nonce_len]
                    ct_and_tag = blob_bytes[nonce_len:]
                    plaintext = aesgcm.decrypt(nonce, ct_and_tag, None)
                    try:
                        obj = json.loads(plaintext)
                        print(f"    -> AES-256-GCM (nonce_len={nonce_len}) JSON! role={obj.get('role','?')}, keys={list(obj.keys())[:10]}")
                        blob_contents.append(('plain', obj))
                    except:
                        print(f"    -> AES-256-GCM (nonce_len={nonce_len}) non-JSON: {plaintext[:100]}")
                        blob_contents.append(('aes-text', plaintext))
                    break
                except Exception as e:
                    pass
        
        # Try protobuf wrapper: field1 = nonce, field2 = ciphertext + tag
        if len(blob_bytes) > 34:
            try:
                # Check if it starts with 0x0a (field 1, wire type 2)
                if blob_bytes[0] == 0x0a:
                    # Read varint length
                    nlen = blob_bytes[1]
                    nonce = blob_bytes[2:2+nlen]
                    remaining = blob_bytes[2+nlen:]
                    if remaining and remaining[0] == 0x12:  # field 2, wire type 2
                        offset2 = 1
                        shift2 = 0
                        clen = 0
                        while offset2 < len(remaining):
                            byte = remaining[offset2]
                            clen |= (byte & 0x7f) << shift2
                            shift2 += 7
                            offset2 += 1
                            if not (byte & 0x80):
                                break
                        ct_and_tag = remaining[offset2:offset2+clen]
                        for nonce_actual in [nonce, nonce[:12], nonce[:16]]:
                            try:
                                aesgcm = AESGCM(key)
                                plaintext = aesgcm.decrypt(nonce_actual, ct_and_tag, None)
                                try:
                                    obj = json.loads(plaintext)
                                    print(f"    -> Proto AES-256-GCM JSON! role={obj.get('role','?')}, keys={list(obj.keys())[:10]}")
                                    blob_contents.append(('plain', obj))
                                    break
                                except:
                                    print(f"    -> Proto AES-256-GCM non-JSON: {plaintext[:100]}")
                                    blob_contents.append(('aes-text', plaintext))
                                break
                            except:
                                continue
                    else:
                        print(f"    -> Protobuf but not aes wrapper: byte={remaining[0]:02x}")
                else:
                    print(f"    -> Encrypted/corrupt (can't decrypt with any method)")
            except Exception as e:
                print(f"    -> Proto decrypt error: {e}")
    else:
        print(f"\n  Blob {i}: {h[:16]}... NOT FOUND")

print(f"\n\n=== Summary: {len(blob_contents)}/{len(blob_hashes)} blobs resolved ===")
for i, (kind, content) in enumerate(blob_contents):
    if kind == 'plain':
        role = content.get('role', '?')
        content_text = content.get('content', '')
        if isinstance(content_text, list):
            text_preview = ' '.join([c.get('text','')[:50] for c in content_text if isinstance(c, dict) and c.get('type') == 'text'])[:100]
        elif isinstance(content_text, str):
            text_preview = content_text[:100]
        else:
            text_preview = str(content_text)[:100]
        print(f"  [{i}] {role}: {text_preview}")

con.close()