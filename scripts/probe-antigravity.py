"""Probe Antigravity conversation storage format."""
import json, os, sys

BASE = os.path.join(os.path.expanduser('~'), '.gemini', 'antigravity')

# --- overview conversations ---
brain_dir = os.path.join(BASE, 'brain')
conversations_dir = os.path.join(BASE, 'conversations')

if not os.path.isdir(brain_dir):
    print('brain dir not found:', brain_dir)
    sys.exit(1)

for conv_id in os.listdir(brain_dir):
    log_path = os.path.join(brain_dir, conv_id, '.system_generated', 'logs', 'overview.txt')
    if not os.path.isfile(log_path):
        continue

    print(f'\n====== Conversation: {conv_id} ======')
    with open(log_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    print(f'Steps: {len(lines)}')

    for line in lines:
        obj = json.loads(line)
        step = obj.get('step_index')
        source = obj.get('source')
        typ = obj.get('type')
        created = obj.get('created_at')
        content = obj.get('content', '')
        tool_calls = obj.get('tool_calls', [])

        label = f'[{step:3}] {source:15} {typ}'
        if content:
            print(label, '-', str(content)[:200])
        elif tool_calls:
            names = [tc.get('name') for tc in tool_calls]
            print(label, '- tools:', names)
        else:
            print(label)

# --- check workspace scope by looking at content for workspace paths ---
print('\n\n====== Summary ======')
print('conversations dir:', conversations_dir)
print('pb files:', os.listdir(conversations_dir) if os.path.isdir(conversations_dir) else 'n/a')
