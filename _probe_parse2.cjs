// Probe: run parseCursorGlobalDb logic using better-sqlite3 directly
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

function extractLexicalText(richTextJson) {
    try {
        const state = JSON.parse(richTextJson);
        const root = state.root ?? state;
        const parts = [];
        walkLexicalNode(root, parts);
        return parts.join('');
    } catch {
        return '';
    }
}

function walkLexicalNode(node, out) {
    if (typeof node.text === 'string') {
        out.push(node.text);
    }
    if (node.type === 'linebreak') {
        out.push('\n');
    }
    const children = node.children;
    if (Array.isArray(children)) {
        for (const child of children) {
            if (typeof child === 'object' && child !== null) {
                walkLexicalNode(child, out);
            }
        }
    }
}

function parseConversationStateBlobHashes(conversationState) {
    const decoded = Buffer.from(conversationState, 'base64');
    const hashes = [];
    let offset = 0;
    while (offset < decoded.length) {
        const tag = decoded[offset];
        if ((tag & 7) !== 2) { break; }
        offset++;
        let length = 0;
        let shift = 0;
        while (offset < decoded.length) {
            const byte = decoded[offset];
            length |= (byte & 0x7f) << shift;
            shift += 7;
            offset++;
            if (!(byte & 0x80)) { break; }
        }
        if (length === 32) {
            hashes.push(decoded.slice(offset, offset + 32).toString('hex'));
        }
        offset += length;
    }
    return hashes;
}

function recoverMessagesFromBlobs(composerId, conversationState, blobContentByHash) {
    const blobHashes = parseConversationStateBlobHashes(conversationState);
    if (blobHashes.length === 0) { return undefined; }

    const messages = [];
    for (const hash of blobHashes) {
        const raw = blobContentByHash.get(hash);
        if (!raw) { continue; }

        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        const role = parsed.role;
        if (role !== 'user' && role !== 'assistant') { continue; }

        let text = '';
        if (typeof parsed.content === 'string') {
            text = parsed.content;
        } else if (Array.isArray(parsed.content)) {
            text = parsed.content
                .map((c) => {
                    if (typeof c === 'object' && c !== null) {
                        return typeof c.text === 'string' ? c.text : '';
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        if (!text.trim()) { continue; }

        const messageIndex = messages.length;
        messages.push({
            id: `${composerId}-blob-${messageIndex}`,
            role: role,
            content: text,
            codeBlocks: [],
        });
    }

    return messages.length > 0 ? messages : undefined;
}

function main() {
    const globalDbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    console.log('Global DB path:', globalDbPath);
    
    const db = new Database(globalDbPath, { readonly: true });

    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'").get();
    if (!tableCheck) { console.log('No cursorDiskKV table'); db.close(); return; }
    console.log('cursorDiskKV table exists');

    const composerRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
    const bubbleRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all();
    const blobRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'").all();

    console.log(`composerRows: ${composerRows.length}, bubbleRows: ${bubbleRows.length}, blobRows: ${blobRows.length}`);

    // Build blob hash map
    const blobContentByHash = new Map();
    for (const row of blobRows) {
        const hash = row.key.slice('agentKv:blob:'.length);
        if (hash) {
            const content = typeof row.value === 'string'
                ? row.value
                : Buffer.from(row.value).toString('utf-8');
            blobContentByHash.set(hash, content);
        }
    }
    console.log(`blobContentByHash: ${blobContentByHash.size} entries`);

    // Build bubble map
    const bubblesByComposer = new Map();
    for (const row of bubbleRows) {
        const firstColon = row.key.indexOf(':');
        if (firstColon < 0) { continue; }
        const remainder = row.key.slice(firstColon + 1);
        const secondColon = remainder.indexOf(':');
        if (secondColon < 0) { continue; }
        const composerId = remainder.slice(0, secondColon);
        const bubbleId = remainder.slice(secondColon + 1);
        if (!composerId || !bubbleId) { continue; }

        let parsed;
        try { parsed = JSON.parse(row.value); } catch { continue; }

        const type = typeof parsed.type === 'number' ? parsed.type : 0;
        const unixMs = (typeof parsed.unixMs === 'number' && parsed.unixMs > 0) ? parsed.unixMs : undefined;

        let text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        if (!text) {
            const rawRich = typeof parsed.richText === 'string' ? parsed.richText.trim() : '';
            if (rawRich) {
                text = extractLexicalText(rawRich).trim();
            }
        }

        if (!text || (type !== 1 && type !== 2)) { continue; }

        let list = bubblesByComposer.get(composerId);
        if (!list) { list = []; bubblesByComposer.set(composerId, list); }
        list.push({ bubbleId, type, text, unixMs });
    }
    console.log(`bubblesByComposer: ${bubblesByComposer.size} composers`);
    for (const [cid, bubbles] of bubblesByComposer) {
        console.log(`  ${cid}: ${bubbles.length} bubbles`);
    }

    // Process each composer
    const results = [];
    for (const row of composerRows) {
        const composerId = row.key.slice('composerData:'.length);
        if (!composerId) { continue; }

        let composerMeta;
        try { composerMeta = JSON.parse(row.value); } catch { continue; }

        const rawBubbles = bubblesByComposer.get(composerId) ?? [];

        const conversationState = typeof composerMeta.conversationState === 'string'
            ? composerMeta.conversationState
            : undefined;
        const blobMessages = conversationState
            ? recoverMessagesFromBlobs(composerId, conversationState, blobContentByHash)
            : undefined;
        const useBlobMessages = blobMessages !== undefined;

        if (rawBubbles.length === 0 && !useBlobMessages) {
            console.log(`  SKIP ${composerId}: no bubbles and no blob messages`);
            continue;
        }

        let messages;
        if (useBlobMessages && blobMessages) {
            messages = blobMessages;
        } else {
            messages = [];
            for (const bubble of rawBubbles) {
                const role = bubble.type === 1 ? 'user' : 'assistant';
                let content = bubble.text;
                const messageIndex = messages.length;
                messages.push({
                    id: `${composerId}-${messageIndex}`,
                    role,
                    content,
                    codeBlocks: [],
                    timestamp: bubble.unixMs !== undefined ? new Date(bubble.unixMs).toISOString() : undefined,
                });
            }
        }

        const name = typeof composerMeta.name === 'string' ? composerMeta.name.trim() : '';
        let title;
        if (name) {
            title = name;
        } else {
            const firstUser = messages.find(m => m.role === 'user');
            if (firstUser) {
                const firstLine = firstUser.content.split('\n')[0] || firstUser.content;
                title = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
            } else {
                title = 'Untitled';
            }
        }

        const createdAt = (typeof composerMeta.createdAt === 'number' && composerMeta.createdAt > 0)
            ? new Date(composerMeta.createdAt).toISOString()
            : (messages.find(m => m.timestamp)?.timestamp ?? new Date().toISOString());

        const lastTimestampMsg = [...messages].reverse().find(m => m.timestamp);
        const updatedAt = lastTimestampMsg?.timestamp ?? createdAt;

        const model = (typeof composerMeta.model === 'string' && composerMeta.model.trim())
            ? composerMeta.model.trim()
            : undefined;

        console.log(`  OK ${composerId}: ${messages.length} msgs, title="${title.substring(0, 40)}", model=${model}, createdAt=${createdAt}`);
        results.push({
            session: {
                id: composerId,
                title,
                source: 'cursor',
                workspaceId: 'cursor-global',
                workspacePath: undefined,
                model,
                messages,
                filePath: globalDbPath,
                createdAt,
                updatedAt,
            },
            errors: [],
        });
    }

    console.log(`\nTotal results: ${results.length}`);
    db.close();
}

main();
