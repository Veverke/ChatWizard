import json
import sys

path = r'C:\Users\avrei\AppData\Roaming\Code\User\workspaceStorage\8cb3f87bbae175605b6e1fd08a5891ec\chatSessions\3866954c-dd43-4f6b-9efb-eba366fb10bd.jsonl'

with open(path, encoding='utf-8') as f:
    content = f.read()
lines = [l.strip() for l in content.split('\n') if l.strip()]

print(f"Total lines: {len(lines)}")

# Examine the bulk requests replacements
bulk_replace_indices = [i for i, l in enumerate(lines) if json.loads(l).get('kind') in (1,2) and json.loads(l).get('k') == ['requests']]
print(f"\nBulk requests replacements at line indices (0-based): {bulk_replace_indices}")

for i in bulk_replace_indices:
    obj = json.loads(lines[i])
    v = obj['v']
    print(f"\n--- Line {i+1} (kind={obj['kind']}, k={obj['k']}) ---")
    if isinstance(v, list):
        print(f"  requests count: {len(v)}")
        for j, r in enumerate(v):
            if isinstance(r, dict):
                kind_val = r.get('kind')
                msg = (r.get('message') or {}).get('text', '')[:80]
                resp_count = len(r.get('response') or [])
                print(f"  [{j}] kind={kind_val!r} msg={msg!r} resp_items={resp_count}")
            else:
                print(f"  [{j}] = {type(r).__name__}: {str(r)[:80]}")

# Now simulate full state replay
print("\n\n=== Full state replay ===")

def deep_set(obj, keys, value):
    for k in keys[:-1]:
        if isinstance(obj, list):
            k = int(k) if not isinstance(k, int) else k
            while len(obj) <= k:
                obj.append(None)
            obj = obj[k]
        elif isinstance(obj, dict):
            key = str(k)
            if key not in obj:
                obj[key] = {}
            obj = obj[key]
        else:
            return
    last = keys[-1]
    if isinstance(obj, list):
        last = int(last) if not isinstance(last, int) else last
        while len(obj) <= last:
            obj.append(None)
        obj[last] = value
    elif isinstance(obj, dict):
        obj[str(last)] = value

state = json.loads(lines[0])['v']
for line in lines[1:]:
    obj = json.loads(line)
    if obj['kind'] in (1, 2):
        # Fix: kind=2 on k=['requests'] is append, not replace
        if obj['kind'] == 2 and obj['k'] == ['requests'] and isinstance(obj['v'], list):
            existing = state.get('requests', []) or []
            state['requests'] = list(existing) + list(obj['v'])
        else:
            deep_set(state, obj['k'], obj['v'])

requests = state.get('requests', [])
print(f"Final requests count: {len(requests)}")
for i, r in enumerate(requests):
    if not isinstance(r, dict):
        print(f"req[{i}] = {type(r).__name__}: {str(r)[:80]}")
        continue
    kind = r.get('kind')
    msg_text = (r.get('message') or {}).get('text', '')[:100]
    resp_items = r.get('response') or []
    text_items = [it for it in resp_items if isinstance(it, dict) and isinstance(it.get('value'), str) and not it.get('kind')]
    print(f"req[{i}] kind={kind!r} msg={msg_text!r} text_resp_items={len(text_items)}")
