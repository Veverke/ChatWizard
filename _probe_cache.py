import sqlite3, json, os

# Find the cache DB
cache_dir = os.path.expandvars(r'%APPDATA%\Code\User\workspaceStorage\8cb3f87bbae175605b6e1fd08a5891ec')
print(f"Looking for cache DB in: {cache_dir}")

# Check if the directory exists
if os.path.isdir(cache_dir):
    for f in os.listdir(cache_dir):
        print(f"  {f}")
else:
    print("  Directory does not exist")

# Also check the extension's storage path
ext_storage = os.path.expandvars(r'%APPDATA%\Code\User\globalStorage\chatwizard')
print(f"\nLooking for cache DB in: {ext_storage}")
if os.path.isdir(ext_storage):
    for f in os.listdir(ext_storage):
        print(f"  {f}")
else:
    print("  Directory does not exist")

# Check for SQLite files in AppData
appdata = os.path.expandvars(r'%APPDATA%')
print(f"\nSearching for chatwizard*.db in {appdata}...")
for root, dirs, files in os.walk(appdata):
    for f in files:
        if 'chatwizard' in f.lower() and f.endswith('.db'):
            print(f"  {os.path.join(root, f)}")
