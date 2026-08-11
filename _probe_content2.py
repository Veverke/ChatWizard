import json, sqlite3, os

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Get all composerData IDs with their contentHash and conversationState
cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
rows = cur.fetchall()

print(f'{"ComposerID":<30} {"Name":<30} {"cs_type":<15} {"contentHash":<20} {"headers":<8}')
print('-'*110)
for k, v in rows:
    cid = k.split(':', 1)[1]
    d = json.loads(v)
    cs = d.get('conversationState', '')
    if not cs:
        cs_type = 'none'
    elif cs == '~':
        cs_type = 'stub(~)'
    elif len(cs) > 50:
        cs_type = 'protobuf'
    else:
        cs_type = f'short({len(cs)})'
    name = (d.get('name', '') or '(unnamed)')[:28]
    ch = d.get('contentHash', '')[:18] or '-'
    hdrs = len(d.get('fullConversationHeadersOnly', []))
    print(f'{cid[:28]:30s} {name:30s} {cs_type:15s} {ch:20s} {hdrs:<8}')

# For stub composers with contentHash, check if content is conversation
print('\n=== Stub composers with contentHash - checking content ===')
cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
for k, v in cur.fetchall():
    cid = k.split(':', 1)[1]
    d = json.loads(v)
    cs = d.get('conversationState', '')
    ch = d.get('contentHash', '')
    if cs == '~' and ch:
        # Check if there's a composer.content entry
        cur2 = con.cursor()
        cur2.execute("SELECT length(value) FROM cursorDiskKV WHERE key = ?", (f'composer.content.{ch}',))
        row2 = cur2.fetchone()
        cur2.close()
        if row2:
            print(f'  {cid[:20]}... contentHash={ch[:20]}... ({row2[0]} bytes)')
            # Read first 200 chars
            cur2 = con.cursor()
            cur2.execute("SELECT value FROM cursorDiskKV WHERE key = ?", (f'composer.content.{ch}',))
            val = cur2.fetchone()[0]
            cur2.close()
            print(f'    Preview: {val[:200]}')
        else:
            print(f'  {cid[:20]}... contentHash={ch[:20]}... NO composer.content entry')

# Check if any stub composers have bubbles with richText
print('\n=== Stub composers with bubbles ===')
for k, v in rows:
    cid = k.split(':', 1)[1]
    d = json.loads(v)
    cs = d.get('conversationState', '')
    if cs == '~':
        cur2 = con.cursor()
        cur2.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?", (f'bubbleId:{cid}:%',))
        bubbles = cur2.fetchall()
        cur2.close()
        if bubbles:
            print(f'  {cid[:20]}... ({len(bubbles)} bubbles)')
            for bk, bv in bubbles:
                bd = json.loads(bv)
                bid = bk.split(':')[-1]
                bt = bd.get('type', '?')
                text = bd.get('text', '')
                rt = bd.get('richText', '')
                print(f'    {bid[:12]}... type={bt} text_len={len(text)} rt_len={len(rt)}')

con.close()