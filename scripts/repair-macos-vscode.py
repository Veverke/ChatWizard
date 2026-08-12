#!/usr/bin/env python3
"""
scripts/repair-macos-vscode.py

Repairs a corrupt @vscode/test-electron install on macOS by:
1. Downloading the VS Code zip with curl
2. Extracting it with Python's zipfile module (preserves symlinks, bundles, permissions)
3. Writing the is-complete marker

Usage:
  python3 scripts/repair-macos-vscode.py <install-dir> <download-url>
"""
import sys
import os
import zipfile
import stat as statmod
import subprocess
import tempfile
import shutil

def main():
    if len(sys.argv) < 3:
        print("Usage: repair-macos-vscode.py <install-dir> <download-url>", file=sys.stderr)
        sys.exit(1)

    install_dir = sys.argv[1]
    url = sys.argv[2]

    # Download
    zip_path = os.path.join(tempfile.gettempdir(), f"vscode-test-{os.getpid()}.zip")
    print(f"[repair] Downloading {url}")
    subprocess.check_call(["curl", "-L", "-o", zip_path, url])

    # List zip contents for debugging
    try:
        with zipfile.ZipFile(zip_path, 'r') as z:
            entries = z.infolist()
            print(f"[repair] Zip has {len(entries)} entries")
            # Show first 10 and last 10
            for info in entries[:10]:
                print(f"  {info.filename} ({info.file_size}B)")
            if len(entries) > 20:
                print(f"  ... ({len(entries) - 20} more entries)")
            for info in entries[-10:]:
                print(f"  {info.filename} ({info.file_size}B)")
            
            # Check for Electron binary
            electron_matches = [i for i in entries if 'Electron' in i.filename and not i.filename.endswith('/')]
            print(f"[repair] Entries matching 'Electron': {len(electron_matches)}")
            for m in electron_matches:
                print(f"  {m.filename} ({m.file_size}B)")
            
            # Check for Contents/MacOS entries
            macos_entries = [i for i in entries if '/Contents/MacOS/' in i.filename]
            print(f"[repair] Entries in Contents/MacOS/: {len(macos_entries)}")
            for m in macos_entries[:10]:
                print(f"  {m.filename} ({m.file_size}B)")
    except Exception as e:
        print(f"[repair] Could not list zip: {e}", file=sys.stderr)

    # Clear corrupt install
    print(f"[repair] Clearing corrupt cache at {install_dir}")
    if os.path.exists(install_dir):
        shutil.rmtree(install_dir)
    os.makedirs(install_dir, exist_ok=True)

    # Extract with zipfile preserving paths and permissions
    print(f"[repair] Extracting with zipfile ...")
    with zipfile.ZipFile(zip_path, 'r') as z:
        for info in z.infolist():
            target = os.path.join(install_dir, info.filename)
            if info.filename.endswith('/'):
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with z.open(info) as src, open(target, 'wb') as dst:
                    dst.write(src.read())
                # Restore executable permissions from the zip
                mode = info.external_attr >> 16
                if mode:
                    try:
                        os.chmod(target, mode & 0o777)
                    except OSError:
                        pass

    # Cleanup
    try:
        os.unlink(zip_path)
    except OSError:
        pass

    # Debug: list top-level of install dir
    print(f"[repair] Contents of {install_dir}:")
    for entry in sorted(os.listdir(install_dir)):
        full = os.path.join(install_dir, entry)
        if os.path.isdir(full):
            print(f"  {entry}/")
            # List one level deeper
            for sub in sorted(os.listdir(full))[:5]:
                sub_full = os.path.join(full, sub)
                sz = os.path.getsize(sub_full) if os.path.isfile(sub_full) else 0
                print(f"    {sub} ({sz}B)" if os.path.isfile(sub_full) else f"    {sub}/")
        else:
            print(f"  {entry} ({os.path.getsize(full)}B)")

    # Check for Electron binary
    expected = os.path.join(install_dir, "Visual Studio Code.app", "Contents", "MacOS", "Electron")
    if os.path.exists(expected):
        print(f"[repair] OK — {expected} exists")
        # Write is-complete marker
        with open(os.path.join(install_dir, 'is-complete'), 'w') as f:
            f.write('')
        sys.exit(0)
    
    # Also check for insiders variant
    expected_insiders = os.path.join(install_dir, "Visual Studio Code - Insiders.app", "Contents", "MacOS", "Electron")
    if os.path.exists(expected_insiders):
        print(f"[repair] OK — {expected_insiders} exists")
        with open(os.path.join(install_dir, 'is-complete'), 'w') as f:
            f.write('')
        sys.exit(0)

    # VS Code 1.133+ renamed the macOS binary from Electron → Code (or Code - Insiders).
    # If the Code binary exists but Electron doesn't, create a symlink
    # so that @vscode/test-electron and our tooling can find it.
    code_binary = os.path.join(install_dir, "Visual Studio Code.app", "Contents", "MacOS", "Code")
    if not os.path.exists(expected) and os.path.exists(code_binary):
        print(f"[repair] Electron binary missing, but Code binary found — creating symlink")
        os.symlink("Code", expected)
        if os.path.exists(expected):
            print(f"[repair] OK — symlink {expected} → Code created")
            with open(os.path.join(install_dir, 'is-complete'), 'w') as f:
                f.write('')
            sys.exit(0)

    code_insiders_binary = os.path.join(install_dir, "Visual Studio Code - Insiders.app", "Contents", "MacOS", "Code - Insiders")
    if not os.path.exists(expected_insiders) and os.path.exists(code_insiders_binary):
        print(f"[repair] Electron binary missing, but Code - Insiders binary found — creating symlink")
        os.symlink("Code - Insiders", expected_insiders)
        if os.path.exists(expected_insiders):
            print(f"[repair] OK — symlink {expected_insiders} → Code - Insiders created")
            with open(os.path.join(install_dir, 'is-complete'), 'w') as f:
                f.write('')
            sys.exit(0)

    print(f"[repair] STILL MISSING — Electron binary not found", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    main()