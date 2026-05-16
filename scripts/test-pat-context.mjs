/**
 * Quick test: call GetContextTool directly for 'PAT' and print what Copilot would receive.
 * Run with: node scripts/test-pat-context.mjs
 */
import { pathToFileURL } from 'url';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'out', 'src');

const { GetContextTool } = await import(pathToFileURL(path.join(outDir, 'mcp/tools/getContextTool.js')).href);
const { FindSimilarTool } = await import(pathToFileURL(path.join(outDir, 'mcp/tools/findSimilarTool.js')).href);
const { SearchTool } = await import(pathToFileURL(path.join(outDir, 'mcp/tools/searchTool.js')).href);
const { FullTextSearchEngine } = await import(pathToFileURL(path.join(outDir, 'search/fullTextEngine.js')).href);
const { SessionIndex } = await import(pathToFileURL(path.join(outDir, 'index/sessionIndex.js')).href);
const { NullSemanticIndexer } = await import(pathToFileURL(path.join(outDir, 'search/semanticContracts.js')).href);
const { startWatcher } = await import(pathToFileURL(path.join(outDir, 'watcher/fileWatcher.js')).href);

const index = new SessionIndex();
const engine = new FullTextSearchEngine();
index.addTypedChangeListener(e => {
    if (e.type === 'batch') { for (const s of e.sessions) engine.index(s); }
    else if (e.type === 'upsert') { engine.index(e.session); }
});

const noopLog = { appendLine: () => {} };
const noopScope = { getSelectedIds: () => [] };

console.log('Loading sessions...');
const watcher = await startWatcher(index, noopLog, noopScope);
await new Promise(r => setTimeout(r, 4000));
console.log(`Loaded ${index.size} sessions.\n`);

const searchTool = new SearchTool(engine, index);
const findSimilar = new FindSimilarTool(new NullSemanticIndexer(), index);
const ctx = new GetContextTool(findSimilar, searchTool, index);

const result = await ctx.execute({ topic: 'PAT', limit: 5 });
console.log('=== RAW TOOL OUTPUT (what Copilot sees) ===\n');
console.log(result.content[0]?.text ?? '(empty)');

watcher.dispose();
