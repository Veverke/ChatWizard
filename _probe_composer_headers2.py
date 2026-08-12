"""Probe: check all composers in composer.composerHeaders."""
import sqlite3, os, json

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

cur.execute("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
row = cur.fetchone()
if row:
    val = row[0]
    parsed = json.loads(val)
    composers = parsed.get('allComposers', [])
    print(f'composer.composerHeaders.allComposers: {len(composers)} items')
    for c in composers:
        cid = c.get('composerId', '?')
        name = c.get('name', '(unnamed)')
        ws = c.get('workspaceIdentifier', {}).get('id', '?')
        created = c.get('createdAt', 0)
        updated = c.get('lastUpdatedAt', c.get('updatedAt', 0))
        print(f'  {str(cid)[:42]:<44} name={str(name)[:35]:<37} ws={str(ws)[:22]:<24} created={created} updated={updated}')

con.close()