import sqlite3
import json
import base64

global_path = r'C:\Users\avrei\AppData\Roaming\Cursor\User\globalStorage\state.vscdb'
con = sqlite3.connect(global_path)
cur = con.cursor()

row = cur.execute("SELECT value FROM cursorDiskKV WHERE key='composerData:7bf8dfc7-73a3-4317-b947-95b9dbaca511'").fetchone()
data = json.loads(row[0])

cs = data.get('conversationState')
print(f"conversationState type: {type(cs).__name__}")
print(f"conversationState length: {len(cs)}")
print(f"First 200 chars: {cs[:200]}")
print(f"Last 200 chars: {cs[-200:]}")

# Check if it's base64
try:
    decoded = base64.b64decode(cs)
    print(f"\nBase64 decoded length: {len(decoded)}")
    print(f"First 50 bytes hex: {decoded[:50].hex()}")
    print(f"First 50 bytes raw: {decoded[:50]}")
except Exception as e:
    print(f"Not base64: {e}")

# Check what characters are in the string
chars = set(cs)
print(f"\nUnique chars: {sorted(chars)[:50]}")
print(f"All printable? {all(c.isprintable() for c in cs)}")

# Try to decode as base64url
try:
    decoded = base64.urlsafe_b64decode(cs + '==')
    print(f"\nBase64url decoded length: {len(decoded)}")
    print(f"First 50 bytes hex: {decoded[:50].hex()}")
except Exception as e:
    print(f"Not base64url: {e}")

# Check the blobEncryptionKey
key_b64 = data.get('blobEncryptionKey')
print(f"\nblobEncryptionKey: {key_b64}")
try:
    key_bytes = base64.b64decode(key_b64)
    print(f"Key bytes length: {len(key_bytes)}")
    print(f"Key hex: {key_bytes.hex()}")
    # If 32 bytes = AES-256, if 16 = AES-128
except Exception as e:
    print(f"Key decode error: {e}")

# Check if there are any other fields that might hint at encryption scheme
print("\n=== All top-level keys ===")
for k, v in data.items():
    if isinstance(v, str) and len(v) > 500:
        print(f"  {k}: str(len={len(v)})")
    elif isinstance(v, str):
        print(f"  {k}: {v[:100]}")
    elif isinstance(v, (list, dict)):
        print(f"  {k}: {type(v).__name__}(len={len(v)})")
    elif v is None:
        print(f"  {k}: None")
    else:
        print(f"  {k}: {v}")

# Check if conversationState might be gzipped after base64 decode
import gzip
try:
    decoded = base64.b64decode(cs)
    if decoded[:2] == b'\x1f\x8b':
        decompressed = gzip.decompress(decoded)
        print(f"\nGzipped! Decompressed length: {len(decompressed)}")
        print(f"First 300: {decompressed[:300]}")
    else:
        print(f"\nNot gzipped. First 2 bytes: {decoded[:2].hex()}")
except Exception as e:
    print(f"\nGzip check failed: {e}")

con.close()