import sqlite3, json, os

db_path = os.path.expandvars(r'%APPDATA%\Cursor\User\globalStorage\state.vscdb')
conn = sqlite3.connect(db_path)

# Test the exact SQL query used by parseCursorGlobalDb
rows = conn.execute("SELECT key, length(value) as vlen FROM cursorDiskKV WHERE key LIKE 'composerData:%'").fetchall()
print(f"LIKE 'composerData:%': {len(rows)} rows")

rows2 = conn.execute("SELECT key, length(value) as vlen FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").fetchall()
print(f"LIKE 'bubbleId:%': {len(rows2)} rows")

rows3 = conn.execute("SELECT key, length(value) as vlen FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'").fetchall()
print(f"LIKE 'agentKv:blob:%': {len(rows3)} rows")

# Check if there are any rows with different key patterns
all_keys = conn.execute("SELECT DISTINCT substr(key, 1, instr(key, ':') - 1) as prefix FROM cursorDiskKV WHERE key LIKE '%:%'").fetchall()
print(f"\nAll key prefixes: {[r[0] for r in all_keys]}")

conn.close()
