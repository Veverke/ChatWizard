# Work Plan: Migrate Cache Manager from `better-sqlite3` to `sql.js`

**Status:** Analysis / Future Work (not started)
**Priority:** Low (post-release)
**Depends on:** sql.js integration for parsers (completed)

---

## 1. Motivation

The extension currently uses two SQLite engines:

| Engine | Where | Purpose |
|---|---|---|
| `better-sqlite3` | `cacheManager.ts`, `cloudSyncManager.ts` | ChatWizard's own persistent session cache |
| `sql.js` (via `sqliteDb.ts`) | `cursor.ts`, `windsurf.ts`, `chronicle.ts` parsers | Reading external SQLite databases from other IDEs |

`better-sqlite3` is a **native C++ addon** compiled against a specific Electron ABI. This causes:

- **NODE_MODULE_VERSION mismatch** when the extension runs inside a different Electron app (Cursor, Windsurf) — the original problem that motivated the sql.js parser fallback.
- **Platform-specific VSIX builds** — 4 separate VSIXs (win32-x64, linux-x64, darwin-x64, darwin-arm64), each with a recompiled native binary.
- **Complex CI/CD** — `rebuild-native.js`, `@electron/rebuild`, MSVC dev command prompt on Windows, `--ignore-scripts` dance.
- **~1.9 MB per VSIX** for the native binary alone.

Migrating the cache manager to `sql.js` would eliminate all of the above.

---

## 2. Current Architecture

### Cache Manager (`src/cache/cacheManager.ts`)

- Opens/creates `chatwizard-cache.db` in the extension's global storage directory.
- Uses `better-sqlite3`'s **synchronous** API throughout:
  - `new BetterSqlite3(dbPath)` — synchronous open
  - `db.prepare(sql)` — synchronous prepared statements
  - `db.transaction(fn)` — synchronous transactions
  - `db.pragma(...)` — synchronous pragma get/set
  - All query methods (`get()`, `all()`, `run()`) — synchronous
- Schema management via `user_version` pragma.
- WAL mode for crash recovery + concurrent reads.
- Exposes `ICacheManager` interface consumed by `SessionIndex`.

### Cloud Sync Manager (`src/cloud/cloudSyncManager.ts`)

- Uses `better-sqlite3` only for VACUUM backup: opens the cache DB, runs `VACUUM`, closes it.
- The rest of the sync logic is JSON-based, not SQLite-dependent.

### sql.js (`src/utils/sqliteDb.ts`)

- Pure WebAssembly — no native compilation, works in any Electron ABI.
- **Async initialization**: `initSqlJs()` returns a `Promise`.
- BLOB columns return `Uint8Array` (not `Buffer`).
- After init, query API is synchronous (`.exec()`, `.prepare()`).
- Currently used as a **fallback** — tries `better-sqlite3` first, catches load failure, falls back to sql.js.

---

## 3. Migration Challenges

### 3.1 Async initialization

`sql.js` requires `await initSqlJs()` before any database can be opened. The cache manager is currently opened synchronously in its constructor/`open()` method. All callers expect the cache to be ready immediately.

**Impact:** The cache manager's `open()` method must become async, and every call site that constructs or opens the cache must `await` it. This ripples through:

- `SessionIndex` constructor/init
- Extension activation (`activate()` in `extension.ts`)
- Watcher initialization
- Any command that reads/writes the cache

### 3.2 Synchronous query expectations

After initialization, `sql.js` queries are synchronous — so the prepared statement pattern can be preserved. The main migration work is in the init path, not the query path.

### 3.3 BLOB handling

`better-sqlite3` returns BLOB columns as `Buffer`. `sql.js` returns them as `Uint8Array`. The cache manager stores session data with text columns (no BLOBs in the current schema), so this is unlikely to be an issue — but worth verifying.

### 3.4 Transaction semantics

`better-sqlite3`'s `db.transaction(fn)` provides a convenient decorator-like API. `sql.js` uses manual `BEGIN`/`COMMIT`/`ROLLBACK`. The migration would need to wrap each transaction block with explicit SQL statements.

### 3.5 Pragma support

`better-sqlite3` has a convenient `db.pragma('key', { simple: true })` API. `sql.js` requires `db.exec("PRAGMA key = value")` and querying `PRAGMA key` via a prepared statement. Minor but mechanical.

### 3.6 Schema versioning

Currently uses `PRAGMA user_version` to track schema version. `sql.js` supports this via `db.exec("PRAGMA user_version = N")` — straightforward.

---

## 4. Migration Plan (if pursued)

### Phase 1: Async cache manager

1. **Make `CacheManager.open()` async** — return `Promise<void>`, use `await getSqlJs()` from `sqliteDb.ts`.
2. **Update `ICacheManager` interface** — change `open(): void` to `open(): Promise<void>`.
3. **Update all callers** — `SessionIndex`, extension activation, watcher.
4. **Replace `better-sqlite3` API calls** with `sql.js` equivalents:
   - `new BetterSqlite3(path)` → `new (await getSqlJs()).Database(path)`
   - `db.pragma('journal_mode = WAL')` → `db.exec('PRAGMA journal_mode = WAL')`
   - `db.pragma('user_version', { simple: true })` → `db.exec('PRAGMA user_version')` + read via prepared statement
   - `db.transaction(fn)` → manual `BEGIN`/`COMMIT`/`ROLLBACK` wrapping
   - `db.prepare(sql)` → `db.prepare(sql)` (same API)
5. **Update `cloudSyncManager.ts`** — replace `new BetterSqlite3(tmpPath)` with sql.js equivalent.

### Phase 2: Remove native dependencies

1. **Remove `better-sqlite3` from `package.json`** — both the dependency and `@types/better-sqlite3`.
2. **Remove `scripts/rebuild-native.js`** — no longer needed.
3. **Remove `npm run rebuild:native` from all npm scripts** — `vscode:prepublish`, `pretest`, `package:vsix:*`.
4. **Remove `--external:better-sqlite3` from esbuild commands** — no longer needed.
5. **Remove `better-sqlite3` entries from `.vscodeignore`** — no longer needed.
6. **Remove `bindings` and `file-uri-to-path` entries from `.vscodeignore`** — these are runtime deps of better-sqlite3 only.

### Phase 3: Simplify CI/CD

1. **Remove `ilammy/msvc-dev-cmd` step** from CI and release workflows.
2. **Remove `npm run rebuild:native` steps** from CI and release workflows.
3. **Remove `--ignore-scripts` from `npm ci`** — no native builds to skip.
4. **Remove VS Code download step** that exists solely for native rebuild ABI detection.
5. **Simplify release workflow** — single build job instead of platform matrix.
6. **Simplify `package-vsix.mjs`** — remove onnxruntime-node patching (that's a separate concern, but the script becomes simpler).

### Phase 4: Universal VSIX

1. **Single VSIX build** — no platform suffix, no per-OS matrix.
2. **Publish single VSIX** to all marketplaces.

---

## 5. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Async init breaks synchronous callers | Runtime errors at startup | Audit all call sites; add defensive `await` |
| Transaction wrapping bugs | Data corruption or partial writes | Unit test all transaction paths; compare with existing behavior |
| Performance regression | sql.js may be slower than native C++ | Benchmark cache operations; sql.js is well-optimized WASM |
| WASM file missing at runtime | Cache fails to open | WASM is included in VSIX via `.vscodeignore`; `locateFile` resolves correctly |
| Schema migration complexity | Existing cache DBs incompatible | Test migration from current schema; `user_version` pragma works identically |

---

## 6. Conclusion

**The ultimate end state is clean and desirable:** a single pure-WASM SQLite engine, no native compilation, universal VSIX, simpler CI/CD. The ~1.9 MB native binary per platform is replaced by a ~691 KB cross-platform WASM file — a net reduction of ~1.2 MB per VSIX.

However, the migration is **non-trivial** due to the synchronous-to-async conversion of the cache manager's initialization path and the ripple effect through all consumers. The current dual-engine architecture (native for cache, WASM for parsers) is a pragmatic compromise that solves the immediate problem without touching the performance-critical cache layer.

**Recommendation:** Defer this work to a dedicated post-release cycle. The sql.js parser integration already solves the primary pain point (reading Cursor/Windsurf DBs inside their own Electron runtimes). The cache manager migration is a separate, self-contained effort with clear scope and measurable success criteria.
