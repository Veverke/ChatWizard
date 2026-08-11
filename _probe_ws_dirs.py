"""Probe: check which workspace dirs exist and have state.vscdb."""
import os, json

root = os.path.expandvars(r'%APPDATA%\Cursor\User\workspaceStorage')
dirs = ['1785882643746', '1785949656739', '1786236927838', '1786241568981', '1786393184506', '1786405873570', '1786411941381', '1786438186197', 'empty-window', '8cb3f87bbae175605b6e1fd08a5891ec']

for d in dirs:
    vscdb = os.path.join(root, d, 'state.vscdb')
    ws_json = os.path.join(root, d, 'workspace.json')
    vscdb_exists = os.path.exists(vscdb)
    ws_exists = os.path.exists(ws_json)
    
    ws_path = None
    if ws_exists:
        try:
            raw = json.loads(open(ws_json).read())
            ws_path = raw.get('folder', '')
        except:
            ws_path = '(parse error)'
    
    print(f'{d:<44} vscdb={vscdb_exists} ws.json={ws_exists} path={ws_path}')