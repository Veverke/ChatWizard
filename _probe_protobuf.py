import sqlite3, json, os, base64

db_path = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
conn = sqlite3.connect(db_path)

# Get the conversationState for a protobuf composer
rows = conn.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").fetchall()

for r in rows:
    try:
        data = json.loads(r[1])
    except:
        continue
    
    cs = data.get('conversationState', '')
    if len(cs) > 1:  # Not a stub
        cid = r[0].replace('composerData:', '')
        print(f'{cid}:')
        print(f'  conversationState length: {len(cs)}')
        print(f'  conversationState (first 50 chars): {cs[:50]}')
        
        # Try to decode as base64
        try:
            decoded = base64.b64decode(cs)
            print(f'  decoded length: {len(decoded)}')
            print(f'  decoded hex (first 100): {decoded[:50].hex()}')
            
            # Parse protobuf
            hashes = []
            offset = 0
            while offset < len(decoded):
                tag = decoded[offset]
                if (tag & 7) != 2:
                    print(f'  stopping at offset {offset}: wire type {(tag & 7)} != 2')
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
                    h = decoded[offset:offset+32].hex()
                    hashes.append(h)
                offset += length
            
            print(f'  parsed {len(hashes)} blob hashes')
            if hashes:
                print(f'  first hash: {hashes[0]}')
        except Exception as e:
            print(f'  decode error: {e}')
        print()

conn.close()
