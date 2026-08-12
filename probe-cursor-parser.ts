/**
 * Probe: directly test parseCursorGlobalDb against the real Cursor global DB.
 * Run with: node -r ts-node/register/transpile-only probe-cursor-parser.ts
 * Or compile first: npx tsc probe-cursor-parser.ts --outDir . --module commonjs --esModuleInterop --skipLibCheck
 */
import * as path from 'path';
import * as fs from 'fs';
import { openReadonlyDb } from './src/utils/sqliteDb';

const GLOBAL_DB = path.join(
    process.env['APPDATA'] || '',
    'Cursor', 'User', 'globalStorage', 'state.vscdb'
);

const WS_ROOT = path.join(
    process.env['APPDATA'] || '',
    'Cursor', 'User', 'workspaceStorage'
);

async function main() {
    console.log('=== Cursor Parser Probe ===\n');

    // 1. Check global DB exists
    console.log(`Global DB: ${GLOBAL_DB}`);
    console.log(`Exists: ${fs.existsSync(GLOBAL_DB)}`);
    if (!fs.existsSync(GLOBAL_DB)) {
        console.error('GLOBAL DB NOT FOUND — aborting');
        return;
    }
    const gStat = fs.statSync(GLOBAL_DB);
    console.log(`Size: ${(gStat.size / 1024).toFixed(0)} KB\n`);

    // 2. Open global DB and inspect cursorDiskKV
    const db = await openReadonlyDb(GLOBAL_DB);
    if (!db) { console.error('Failed to open global DB'); return; }

    const tableCheck = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'"
    );
    console.log(`cursorDiskKV table exists: ${!!tableCheck}`);

    if (tableCheck) {
        const count = db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM cursorDiskKV');
        console.log(`cursorDiskKV row count: ${count?.cnt ?? 0}`);

        // Check key types
        const keyTypes = db.query<{ prefix: string; cnt: number }>(
            `SELECT 
                CASE 
                    WHEN key LIKE 'composerData:%' THEN 'composerData'
                    WHEN key LIKE 'bubbleId:%' THEN 'bubbleId'
                    WHEN key LIKE 'agentKv:blob:%' THEN 'agentKv:blob'
                    ELSE SUBSTR(key, 1, INSTR(key, ':') - 1)
                END as prefix,
                COUNT(*) as cnt
            FROM cursorDiskKV 
            GROUP BY prefix
            ORDER BY cnt DESC`
        );
        console.log('\nKey type distribution:');
        for (const row of keyTypes) {
            console.log(`  ${row.prefix}: ${row.cnt}`);
        }

        // Check composerData rows
        const composerRows = db.query<{ key: string; value: string }>(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
        );
        console.log(`\nComposerData rows: ${composerRows.length}`);

        // Check bubbleId rows
        const bubbleRows = db.query<{ key: string; value: string }>(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"
        );
        console.log(`BubbleId rows: ${bubbleRows.length}`);

        // Check blob rows
        const blobRows = db.query<{ key: string; value: string }>(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'"
        );
        console.log(`AgentKv:blob rows: ${blobRows.length}`);

        // 3. Deep inspect each composer
        console.log('\n=== Composer Deep Inspection ===');
        for (const row of composerRows) {
            const composerId = row.key.slice('composerData:'.length);
            let meta: any;
            try { meta = JSON.parse(row.value); } catch { 
                console.log(`\n[${composerId}] FAILED to parse JSON`);
                continue; 
            }

            const name = meta.name || '(unnamed)';
            const createdAt = meta.createdAt ? new Date(meta.createdAt).toISOString() : 'unknown';
            const updatedAt = meta.updatedAt ? new Date(meta.updatedAt).toISOString() : 'unknown';
            const model = meta.model || '(no model)';
            const convState = meta.conversationState ? `${meta.conversationState.slice(0, 40)}...` : '(none)';
            
            // Count bubbles for this composer
            const compBubbles = bubbleRows.filter(b => b.key.includes(`:${composerId}:`));
            const hasRichText = compBubbles.some(b => {
                try {
                    const v = JSON.parse(b.value);
                    return typeof v.richText === 'string' && v.richText.length > 10;
                } catch { return false; }
            });
            const hasText = compBubbles.some(b => {
                try {
                    const v = JSON.parse(b.value);
                    return typeof v.text === 'string' && v.text.trim().length > 0;
                } catch { return false; }
            });

            // Count blob messages
            let blobMsgCount = 0;
            if (meta.conversationState) {
                try {
                    const { parseConversationStateBlobHashes } = await import('./src/parsers/cursor');
                    const hashes = parseConversationStateBlobHashes(meta.conversationState);
                    blobMsgCount = hashes.length;
                } catch {}
            }

            console.log(`\n[${composerId.slice(0, 8)}…]`);
            console.log(`  Name:       ${name}`);
            console.log(`  Model:      ${model}`);
            console.log(`  Created:    ${createdAt}`);
            console.log(`  Updated:    ${updatedAt}`);
            console.log(`  Bubbles:    ${compBubbles.length} (text=${hasText}, richText=${hasRichText})`);
            console.log(`  Blob refs:  ${blobMsgCount}`);
            console.log(`  convState:  ${convState}`);
            
            // Show first bubble content if any
            if (compBubbles.length > 0) {
                const firstBubble = compBubbles[0];
                try {
                    const bv = JSON.parse(firstBubble.value);
                    const textPreview = (bv.text || '').slice(0, 120) || '(empty text)';
                    const richPreview = bv.richText ? `(richText: ${bv.richText.length}B)` : '(no richText)';
                    console.log(`  First bubble: type=${bv.type}, text="${textPreview}", ${richPreview}`);
                } catch {}
            }
        }
    }

    db.close();

    // 4. Check workspace discovery
    console.log('\n=== Workspace Discovery ===');
    console.log(`WS Root: ${WS_ROOT}`);
    console.log(`Exists: ${fs.existsSync(WS_ROOT)}`);
    
    if (fs.existsSync(WS_ROOT)) {
        const dirs = fs.readdirSync(WS_ROOT, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        console.log(`Workspace dirs: ${dirs.length}`);
        
        for (const dir of dirs.slice(0, 10)) {
            const vscdbPath = path.join(WS_ROOT, dir, 'state.vscdb');
            const wsJsonPath = path.join(WS_ROOT, dir, 'workspace.json');
            const hasVscdb = fs.existsSync(vscdbPath);
            const hasWsJson = fs.existsSync(wsJsonPath);
            
            let wsPath = '(unknown)';
            if (hasWsJson) {
                try {
                    const raw = fs.readFileSync(wsJsonPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    wsPath = parsed.folder || '(no folder)';
                } catch {}
            }
            
            console.log(`  ${dir.slice(0, 12)}… vscdb=${hasVscdb} ws.json=${hasWsJson} path=${wsPath}`);
        }
        if (dirs.length > 10) {
            console.log(`  ... and ${dirs.length - 10} more`);
        }
    }

    // 5. Check selectedIds / scope
    console.log('\n=== Scope Check ===');
    // The workspace ID for this project is 8cb3f87bbae175605b6e1fd08a5891ec
    const ourWsId = '8cb3f87bbae175605b6e1fd08a5891ec';
    const ourDir = dirs?.find(d => d === ourWsId);
    console.log(`Our workspace (${ourWsId}) found in Cursor workspaceStorage: ${!!ourDir}`);
    
    // Check if there's a state.vscdb in our workspace
    if (ourDir) {
        const ourVscdb = path.join(WS_ROOT, ourWsId, 'state.vscdb');
        console.log(`Our state.vscdb exists: ${fs.existsSync(ourVscdb)}`);
        if (fs.existsSync(ourVscdb)) {
            const ourStat = fs.statSync(ourVscdb);
            console.log(`Our state.vscdb size: ${(ourStat.size / 1024).toFixed(0)} KB`);
            
            // Open and check cursorDiskKV in workspace DB
            const wsDb = await openReadonlyDb(ourVscdb);
            if (wsDb) {
                const wsTableCheck = wsDb.get<{ name: string }>(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'"
                );
                console.log(`Workspace DB has cursorDiskKV: ${!!wsTableCheck}`);
                if (wsTableCheck) {
                    const wsCount = wsDb.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM cursorDiskKV');
                    console.log(`Workspace DB cursorDiskKV rows: ${wsCount?.cnt ?? 0}`);
                }
                wsDb.close();
            }
        }
    }
}

main().catch(console.error);