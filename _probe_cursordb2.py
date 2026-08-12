import sqlite3, json, os

db_path = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Get all composerData rows
cd_rows = conn.execute(
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key",
    ('composerData:%',)
).fetchall()

print("=== ComposerData analysis ===")
for r in cd_rows:
    composer_id = r['key'].replace('composerData:', '')
    val = r['value']
    try:
        data = json.loads(val)
    except:
        print(f'{composer_id}: FAILED TO PARSE')
        continue
    
    has_bubbles = len(data.get('fullConversationHeadersOnly', [])) > 0
    has_rich_text = bool(data.get('richText', '').strip())
    has_text = bool(data.get('text', '').strip())
    has_conversation_state = bool(data.get('conversationState', '').strip())
    has_name = bool(data.get('name', '').strip())
    created_at = data.get('createdAt', 'N/A')
    
    print(f'{composer_id}:')
    print(f'  bubbles={has_bubbles} richText={has_rich_text} text={has_text} convState={has_conversation_state} name={has_name}')
    print(f'  createdAt={created_at}')
    if has_bubbles:
        headers = data.get('fullConversationHeadersOnly', [])
        print(f'  bubbleCount={len(headers)}')
    if has_conversation_state:
        cs = data['conversationState']
        print(f'  conversationState length={len(cs)}')

# Get bubbleId rows grouped by composer
bubble_rows = conn.execute(
    "SELECT key, length(value) as vlen FROM cursorDiskKV WHERE key LIKE ? ORDER BY key",
    ('bubbleId:%',)
).fetchall()

print("\n=== BubbleId by composer ===")
composer_bubbles = {}
for r in bubble_rows:
    parts = r['key'].split(':')
    if len(parts) >= 3:
        cid = parts[1]
        if cid not in composer_bubbles:
            composer_bubbles[cid] = []
        composer_bubbles[cid].append(r['key'])

for cid, bubbles in sorted(composer_bubbles.items()):
    print(f'{cid}: {len(bubbles)} bubbles')

conn.close()
