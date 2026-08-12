"""Probe: check composer.composerData and aiService content in workspace DB."""
import sqlite3, os, json

ws = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage\8cb3f87bbae175605b6e1fd08a5891ec\state.vscdb')
con = sqlite3.connect(ws)
cur = con.cursor()

# Check composer.composerData
cur.execute("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
row = cur.fetchone()
if row:
    val = row[0]
    print(f'composer.composerData: {len(val)} bytes')
    print(f'Content: {val[:500]}')
    print()
    try:
        parsed = json.loads(val)
        print(f'Parsed keys: {list(parsed.keys())}')
        if 'allComposers' in parsed:
            print(f'allComposers: {len(parsed["allComposers"])} items')
            for c in parsed['allComposers'][:5]:
                print(f'  {str(c)[:200]}')
        if 'composers' in parsed:
            print(f'composers: {len(parsed["composers"])} items')
            for c in parsed['composers'][:5]:
                print(f'  {str(c)[:200]}')
    except json.JSONDecodeError as e:
        print(f'JSON parse error: {e}')
else:
    print('composer.composerData not found')

# Check aiService.prompts
cur.execute("SELECT value FROM ItemTable WHERE key = 'aiService.prompts'")
row = cur.fetchone()
if row:
    val = row[0]
    print(f'\naiService.prompts: {len(val)} bytes')
    try:
        parsed = json.loads(val)
        if isinstance(parsed, list):
            print(f'  Array of {len(parsed)} items')
            for i, p in enumerate(parsed[:3]):
                print(f'  [{i}] {str(p)[:200]}')
        else:
            print(f'  {str(parsed)[:500]}')
    except json.JSONDecodeError as e:
        print(f'  JSON parse error: {e}')
else:
    print('\naiService.prompts not found')

# Check aiService.generations
cur.execute("SELECT value FROM ItemTable WHERE key = 'aiService.generations'")
row = cur.fetchone()
if row:
    val = row[0]
    print(f'\naiService.generations: {len(val)} bytes')
    try:
        parsed = json.loads(val)
        if isinstance(parsed, list):
            print(f'  Array of {len(parsed)} items')
            for i, p in enumerate(parsed[:3]):
                print(f'  [{i}] {str(p)[:200]}')
        else:
            print(f'  {str(parsed)[:500]}')
    except json.JSONDecodeError as e:
        print(f'  JSON parse error: {e}')
else:
    print('\naiService.generations not found')

con.close()