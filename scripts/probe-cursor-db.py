"""One-off probe: list ItemTable keys and sample composer JSON shape from a Cursor state.vscdb."""
import json
import sqlite3
import sys

def main() -> None:
    db = sys.argv[1] if len(sys.argv) > 1 else None
    if not db:
        print("Usage: python scripts/probe-cursor-db.py <path-to-state.vscdb>")
        sys.exit(1)
    uri = "file:" + db.replace("\\", "/") + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    cur = con.cursor()
    cur.execute(
        "SELECT key FROM ItemTable WHERE key LIKE '%composer%' OR key LIKE '%Composer%' "
        "OR key LIKE '%chat%' OR key LIKE '%Chat%' ORDER BY key LIMIT 200"
    )
    keys = [r[0] for r in cur.fetchall()]
    print("--- largest ItemTable rows (top 25 by value length) ---")
    cur.execute(
        "SELECT key, length(value) AS n FROM ItemTable ORDER BY n DESC LIMIT 25"
    )
    for row in cur.fetchall():
        print(f"  {row[1]:>10}  {row[0]}")

    print("\n--- matching keys (first 200) ---")
    for k in keys:
        print(k)

    cur.execute("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
    row = cur.fetchone()
    def peek_ai_service(label: str) -> None:
        cur.execute("SELECT value FROM ItemTable WHERE key = ?", (label,))
        r2 = cur.fetchone()
        if not r2:
            print(f"\n--- no {label} ---")
            return
        raw2 = r2[0]
        print(f"\n--- {label} length: {len(raw2)} ---")
        try:
            j = json.loads(raw2)
        except json.JSONDecodeError as e:
            print(f"  JSON error: {e}")
            print(f"  raw head: {raw2[:200]!r}")
            return
        if isinstance(j, list):
            print(f"  top: list len={len(j)}")
            if j:
                print(f"  [0] type={type(j[0]).__name__}")
                if isinstance(j[0], dict):
                    print(f"  [0] keys: {list(j[0].keys())[:40]}")
        elif isinstance(j, dict):
            print(f"  top: dict keys: {list(j.keys())[:40]}")
        else:
            print(f"  top: {type(j).__name__}")

    peek_ai_service("aiService.generations")
    peek_ai_service("aiService.prompts")

    if not row:
        print("\n--- no composer.composerData row ---")
        con.close()
        return
    raw = row[0]
    print(f"\n--- composer.composerData length: {len(raw)} ---")
    data = json.loads(raw)
    ac = data.get("allComposers") or data.get("composers") or []
    print(f"composer count: {len(ac)}")
    if ac:
        c0 = ac[0]
        print("--- first composer top-level keys ---")
        print(sorted(c0.keys()) if isinstance(c0, dict) else type(c0))
        if isinstance(c0, dict):
            for k in ("conversation", "messages", "fullConversation", "chat", "bubbles", "timeline", "branches", "activeBranch"):
                v = c0.get(k)
                if v is not None:
                    print(f"  {k}: type={type(v).__name__} len={len(v) if hasattr(v, '__len__') else 'n/a'}")
            br = c0.get("branches")
            if isinstance(br, list) and br:
                print("--- branches[0] (list) ---")
                b0 = br[0]
                print(f"  type={type(b0).__name__}")
                if isinstance(b0, dict):
                    print(f"  keys: {list(b0.keys())[:50]}")
                    for mk in ("conversation", "messages", "chat", "bubbles", "head"):
                        if mk in b0:
                            mv = b0[mk]
                            print(f"  {mk}: type={type(mv).__name__} len={len(mv) if hasattr(mv, '__len__') else 'n/a'}")
            elif isinstance(br, dict):
                print("--- branches sample (first 2 keys) ---")
                for i, (bk, bv) in enumerate(br.items()):
                    if i >= 2:
                        break
                    print(f"  branch {bk!r}: type={type(bv).__name__}")
                    if isinstance(bv, dict):
                        print(f"    keys: {list(bv.keys())[:40]}")
                        for mk in ("conversation", "messages", "chat", "bubbles"):
                            if mk in bv:
                                mv = bv[mk]
                                print(f"    {mk}: type={type(mv).__name__} len={len(mv) if hasattr(mv, '__len__') else 'n/a'}")
            ab = c0.get("activeBranch")
            if isinstance(ab, dict):
                print("--- activeBranch keys ---")
                print(list(ab.keys()))
                for mk in ("conversation", "messages", "chat", "bubbles"):
                    if mk in ab:
                        mv = ab[mk]
                        print(f"  {mk}: type={type(mv).__name__} len={len(mv) if hasattr(mv, '__len__') else 'n/a'}")
            conv = c0.get("conversation") or c0.get("messages")
            if isinstance(conv, list) and conv:
                print("--- first message item keys ---")
                print(sorted(conv[0].keys()) if isinstance(conv[0], dict) else conv[0])

    print("\n--- workbench.panel.composerChatViewPane.* row sizes ---")
    cur.execute(
        "SELECT key, length(value) FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'"
    )
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} bytes")

    print("\n--- workbench.panel.aichat.* (by size, top 15) ---")
    cur.execute(
        "SELECT key, length(value) AS n FROM ItemTable WHERE key LIKE 'workbench.panel.aichat.%' "
        "ORDER BY n DESC LIMIT 15"
    )
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} bytes")

    print("\n--- workbench.backgroundComposer.workspacePersistentData size ---")
    cur.execute(
        "SELECT length(value) FROM ItemTable WHERE key = 'workbench.backgroundComposer.workspacePersistentData'"
    )
    r = cur.fetchone()
    if r:
        print(f"  {r[0]} bytes")

    print("\n--- first composerChatViewPane value keys (if JSON) ---")
    cur.execute(
        "SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%' LIMIT 1"
    )
    row = cur.fetchone()
    if row:
        k, v = row
        try:
            pj = json.loads(v)
            print(f"  key={k}")
            print(f"  top keys: {list(pj.keys())[:50] if isinstance(pj, dict) else type(pj)}")
            if isinstance(pj, dict) and "messages" in pj:
                msgs = pj["messages"]
                print(f"  messages len={len(msgs) if hasattr(msgs, '__len__') else 'n/a'}")
                if isinstance(msgs, list) and msgs:
                    print(f"  first msg keys: {list(msgs[0].keys()) if isinstance(msgs[0], dict) else msgs[0]}")
        except json.JSONDecodeError as e:
            print(f"  not JSON: {e}")
    con.close()

if __name__ == "__main__":
    main()
