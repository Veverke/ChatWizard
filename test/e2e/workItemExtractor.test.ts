// test/e2e/workItemExtractor.test.ts
import * as assert from 'assert';
import { extractWorkItems, extractWorkItemsFromSession, DEFAULT_WORK_ITEM_PATTERN } from '../../src/utils/workItemExtractor';

suite('workItemExtractor', () => {

    suite('extractWorkItems', () => {

        test('extracts JIRA-style IDs', () => {
            const items = extractWorkItems('Fixing bug in ABC-123 and DEF-456');
            assert.ok(items.includes('ABC-123'));
            assert.ok(items.includes('DEF-456'));
        });

        test('extracts GitHub issue (#123)', () => {
            const items = extractWorkItems('Closed #42');
            assert.ok(items.some(i => i.includes('42')));
        });

        test('extracts GH-style IDs (GH-123)', () => {
            const items = extractWorkItems('Resolves GH-99');
            assert.ok(items.some(i => i.includes('99')));
        });

        test('extracts Azure DevOps AB#123', () => {
            const items = extractWorkItems('Working on AB#500');
            assert.ok(items.some(i => i.includes('500')));
        });

        test('returns empty array for plain text', () => {
            const items = extractWorkItems('No work item here.');
            assert.strictEqual(items.length, 0);
        });

        test('falls back to default on invalid regex', () => {
            const items = extractWorkItems('XY-999', '[[invalid');
            assert.ok(Array.isArray(items));
        });

    });

    suite('extractWorkItemsFromSession', () => {

        test('finds work items in title', () => {
            const items = extractWorkItemsFromSession('Fix PROJ-42 crash', []);
            assert.ok(items.some(i => i.includes('42')));
        });

        test('finds work items in messages', () => {
            const messages = [{ role: 'user' as const, content: 'Need to fix PROJ-77', timestamp: '', codeBlocks: [] }];
            const items = extractWorkItemsFromSession('plain title', messages);
            assert.ok(items.some(i => i.includes('77')));
        });

        test('deduplicates work items', () => {
            const messages = [
                { role: 'user' as const, content: 'XYZ-1 issue', timestamp: '', codeBlocks: [] },
                { role: 'user' as const, content: 'also XYZ-1', timestamp: '', codeBlocks: [] },
            ];
            const items = extractWorkItemsFromSession('XYZ-1', messages);
            assert.strictEqual(items.filter(i => i.includes('XYZ-1')).length, 1);
        });

    });

});
