"""Probe: check composer.composerHeaders content in global DB ItemTable."""
import sqlite3, os, json

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

cur.execute("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
row = cur.fetchone()
if row:
    val = row[0]
    print(f'composer.composerHeaders: {len(val)} bytes')
    try:
        parsed = json.loads(val)
        if isinstance(parsed, dict):
            print(f'Keys: {list(parsed.keys())}')
            for k, v in parsed.items():
                if isinstance(v, list):
                    print(f'  {k}: list of {len(v)} items')
                    for item in v[:3]:
                        print(f'    {str(item)[:150]}')
                else:
                    print(f'  {k}: {str(v)[:150]}')
        elif isinstance(parsed, list):
            print(f'Array of {len(parsed)} items')
            for item in parsed[:5]:
                print(f'  {str(item)[:200]}')
        else:
            print(f'Type: {type(parsed).__name__}')
            print(f'Value: {str(parsed)[:500]}')
    except json.JSONDecodeError as e:
        print(f'JSON parse error: {e}')
else:
    print('composer.composerHeaders not found')

con.close()