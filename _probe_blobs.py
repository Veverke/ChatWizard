import json, sqlite3, os

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Check the protobuf composers - do they have blob entries?
cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
for k, v in cur.fetchall():
    cid = k.split(':', 1)[1]
    d = json.loads(v)
    cs = d.get('conversationState', '')
    if len(cs) > 5:  # protobuf
        # Parse blob hashes from protobuf
        decoded = bytes.fromhex(cs) if all(c in '0123456789abcdefABCDEF' for c in cs) else None
        if not decoded:
            try:
                import base64
                decoded = base64.b64decode(cs)
            except:
                pass
        if decoded:
            hashes = []
            offset = 0
            while offset < len(decoded):
                tag = decoded[offset]
                if (tag & 7) != 2:
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
            
            # Check if blobs exist
            name = d.get('name', '') or '(unnamed)'
            found = 0
            for h in hashes:
                cur2 = con.cursor()
                cur2.execute("SELECT 1 FROM cursorDiskKV WHERE key = ?", (f'agentKv:blob:{h}',))
                if cur2.fetchone():
                    found += 1
                cur2.close()
            print(f'{cid[:20]}... name={name[:25]:25s} hashes={len(hashes)} blobs_found={found}')

con.close()