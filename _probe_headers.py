"""Probe: check composerHeaders in global DB and workspace DB."""
import sqlite3, os, json

gdb = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
con = sqlite3.connect(gdb)
cur = con.cursor()

# Check composerHeaders table
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='composerHeaders'")
if cur.fetchone():
    cur.execute("PRAGMA table_info(composerHeaders)")
    cols = cur.fetchall()
    print('composerHeaders columns:')
    for c in cols:
        print(f'  {c}')
    
    cur.execute("SELECT COUNT(*) FROM composerHeaders")
    print(f'\ncomposerHeaders rows: {cur.fetchone()[0]}')
    
    cur.execute("SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent FROM composerHeaders ORDER BY lastUpdatedAt DESC")
    rows = cur.fetchall()
    print(f'\nAll composerHeaders (ordered by lastUpdatedAt):')
    for r in rows:
        print(f'  {str(r[0])[:42]:<44} ws={str(r[1])[:22]:<24} created={r[2]} updated={r[3]} archived={r[4]} subagent={r[5]}')
    
    # Check which workspace IDs are referenced
    cur.execute("SELECT DISTINCT workspaceId FROM composerHeaders")
    ws_ids = [r[0] for r in cur.fetchall()]
    print(f'\nDistinct workspaceIds: {ws_ids}')
    
    # Check for our workspace
    our_ws = '8cb3f87bbae175605b6e1fd08a5891ec'
    cur.execute("SELECT COUNT(*) FROM composerHeaders WHERE workspaceId = ?", (our_ws,))
    print(f'composerHeaders for our workspace ({our_ws}): {cur.fetchone()[0]}')
    
    cur.execute("SELECT composerId, lastUpdatedAt FROM composerHeaders WHERE workspaceId = ? ORDER BY lastUpdatedAt DESC", (our_ws,))
    for r in cur.fetchall():
        print(f'  {str(r[0])[:42]:<44} updated={r[1]}')

con.close()

# Also check workspace DB composerHeaders
ws = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage\8cb3f87bbae175605b6e1fd08a5891ec\state.vscdb')
con2 = sqlite3.connect(ws)
cur2 = con2.cursor()
cur2.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='composerHeaders'")
if cur2.fetchone():
    cur2.execute("SELECT COUNT(*) FROM composerHeaders")
    print(f'\nWorkspace DB composerHeaders rows: {cur2.fetchone()[0]}')
    cur2.execute("SELECT composerId, workspaceId, lastUpdatedAt FROM composerHeaders ORDER BY lastUpdatedAt DESC")
    for r in cur2.fetchall():
        print(f'  {str(r[0])[:42]:<44} ws={str(r[1])[:22]:<24} updated={r[2]}')
else:
    print('\nWorkspace DB has no composerHeaders table')
con2.close()