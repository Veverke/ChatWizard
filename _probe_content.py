import json, sqlite3, os

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Get all composerData IDs
cur.execute("SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
composers = [r[0].split(':', 1)[1] for r in cur.fetchall()]

# For each composer, check if there's a composer.content entry
print('=== composer.content mapping ===')
cur.execute("SELECT key, length(value) FROM cursorDiskKV WHERE key LIKE 'composer.content.%'")
content_keys = {}
for k, vlen in cur.fetchall():
    content_keys[k] = vlen

# Check if composer.content keys are SHA256 of something
# Let's look at the content of one
cur.execute("SELECT key, value FROM cursorDiskKV WHERE key = 'composer.content.4cf7ebf3e10b85c133f4bf112e51240078cb441359735b7e757fcfc652143269'")
row = cur.fetchone()
if row:
    val = row[1]
    print(f'\nSample composer.content value ({len(val)} bytes):')
    print(val[:2000])
    print('...')

# Check if composerData has a contentHash field
print('\n=== composerData contentHash fields ===')
for cid in composers:
    cur.execute("SELECT value FROM cursorDiskKV WHERE key = ?", (f'composerData:{cid}',))
    row = cur.fetchone()
    if row:
        d = json.loads(row[0])
        ch = d.get('contentHash', '')
        cs = d.get('conversationState', '')[:20]
        name = d.get('name', '') or '(unnamed)'
        print(f'  {cid[:20]}... name={name[:25]:25s} cs={cs!r:22s} contentHash={str(ch)[:40]}')

# Check if composer.content keys match any contentHash
print('\n=== contentHash matching ===')
for cid in composers:
    cur.execute("SELECT value FROM cursorDiskKV WHERE key = ?", (f'composerData:{cid}',))
    row = cur.fetchone()
    if row:
        d = json.loads(row[0])
        ch = d.get('contentHash', '')
        if ch and f'composer.content.{ch}' in content_keys:
            print(f'  {cid[:20]}... -> MATCH composer.content.{ch[:20]}... ({content_keys[f"composer.content.{ch}"]} bytes)')

con.close()