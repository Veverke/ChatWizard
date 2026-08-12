import sqlite3
import json
import base64

global_path = r'C:\Users\avrei\AppData\Roaming\Cursor\User\globalStorage\state.vscdb'
con = sqlite3.connect(global_path)
cur = con.cursor()

# Get all composers
composers = cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").fetchall()
print(f"Total composers: {len(composers)}")

# For each composer, check bubble text status and conversationState presence
affected = []
for ckey, cval in composers:
    composer_id = ckey[len('composerData:'):]
    try:
        data = json.loads(cval)
    except:
        continue
    
    name = data.get('name', '')
    n_bubbles = len(data.get('fullConversationHeadersOnly', []))
    has_cs = bool(data.get('conversationState'))
    is_agentic = data.get('isAgentic', False)
    agent_backend = data.get('agentBackend', '')
    
    # Count bubbles with text
    bubbles_with_text = 0
    total_bubbles = 0
    br = cur.execute("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?", (f'bubbleId:{composer_id}:%',)).fetchall()
    for bkey, bval in br:
        total_bubbles += 1
        try:
            bdata = json.loads(bval)
            if bdata.get('text'):
                bubbles_with_text += 1
        except:
            pass
    
    status = 'MISSING' if has_cs and bubbles_with_text == 0 else ('PARTIAL' if has_cs and bubbles_with_text < total_bubbles else 'OK')
    if has_cs and (bubbles_with_text == 0 or bubbles_with_text < total_bubbles):
        affected.append(composer_id)
    
    print(f"{composer_id[:12]}... name='{name[:40]}' bubbles={total_bubbles} wText={bubbles_with_text} headers={n_bubbles} agentic={is_agentic} backend={agent_backend} hasCS={bool(has_cs)} status={status}")

print(f"\nTotal affected (has CS but bubbles missing text): {len(affected)}")
print(f"Affected IDs: {[a[:12] for a in affected]}")

con.close()