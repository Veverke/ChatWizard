// test/e2e/workItemExtractorRealWorld.test.ts
//
// Tests work-item extraction against the kind of conversation content that
// developers actually write when discussing sprint tasks with AI assistants.
//
// Real-world patterns observed:
//   - JIRA:       AUTH-2847, PLAT-133, INFRA-9901
//   - GitHub:     #42, GH-123, Fixes #101
//   - Azure DevOps: AB#5512
//   - Mixed in prose, commit messages, PR descriptions

import * as assert from 'assert';
import { extractWorkItems, extractWorkItemsFromSession } from '../../src/utils/workItemExtractor';
import { Message } from '../../src/types/index';

function makeMessages(contents: string[]): Message[] {
    return contents.map((content, i) => ({
        id: `msg-${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content,
        timestamp: new Date().toISOString(),
        codeBlocks: [],
    }));
}

suite('extractWorkItems — realistic prose', () => {

    test('extracts JIRA ticket from sprint planning conversation', () => {
        const text = 'I\'m working on AUTH-2847 today — the JWT expiry bug. It blocks PLAT-133 (the SSO migration).';
        const items = extractWorkItems(text);
        assert.ok(items.includes('AUTH-2847'), `Missing AUTH-2847, got: ${items.join(', ')}`);
        assert.ok(items.includes('PLAT-133'), `Missing PLAT-133, got: ${items.join(', ')}`);
    });

    test('extracts GitHub issue number from a "Fixes #N" commit message style', () => {
        const text = 'This PR fixes #101 — the null pointer in the user controller. Also closes #88.';
        const items = extractWorkItems(text);
        assert.ok(items.some(i => i.includes('101')), `Missing #101, got: ${items.join(', ')}`);
        assert.ok(items.some(i => i.includes('88')), `Missing #88, got: ${items.join(', ')}`);
    });

    test('extracts Azure DevOps work item from AB#N pattern', () => {
        const text = 'Sprint goal is to close AB#5512 (performance regression) and AB#5519 (memory leak in the session indexer).';
        const items = extractWorkItems(text);
        assert.ok(items.some(i => i.includes('5512')), `Missing AB#5512, got: ${items.join(', ')}`);
        assert.ok(items.some(i => i.includes('5519')), `Missing AB#5519, got: ${items.join(', ')}`);
    });

    test('does not extract version numbers as work items', () => {
        const text = 'Upgraded to Node.js 20.12.0 and TypeScript 5.4.2. No tickets involved.';
        const items = extractWorkItems(text);
        // Version numbers like 20.12.0 should not be extracted as JIRA tickets
        assert.ok(!items.some(i => i === 'NODE-20' || i.includes('5.4')),
            `Version numbers should not be extracted as work items: ${items.join(', ')}`);
    });

    test('returns empty for a plain debugging conversation with no ticket references', () => {
        const text = 'Why is my Promise chain swallowing errors? I added a .catch() but it never fires.';
        const items = extractWorkItems(text);
        assert.strictEqual(items.length, 0, `Expected no work items, got: ${items.join(', ')}`);
    });

    test('multiple mentions of the same ticket are deduplicated', () => {
        const text = 'AUTH-2847 is my top priority. Auth-2847 keeps coming up in standup. Working on AUTH-2847 today.';
        const items = extractWorkItems(text);
        const auth2847Count = items.filter(i => i.toUpperCase() === 'AUTH-2847').length;
        assert.strictEqual(auth2847Count, 1, `AUTH-2847 should appear exactly once, got: ${items.join(', ')}`);
    });

});

suite('extractWorkItemsFromSession — full session context', () => {

    test('sprint planning session: ticket in title + more in messages', () => {
        const title = 'AUTH-2847: Fix JWT expiry handling in the login flow';
        const messages = makeMessages([
            'I\'m working on AUTH-2847 — the JWT token is expiring 30 seconds earlier than the configured 24h window.',
            'This could be related to PLAT-133, which changed how we load JWT_SECRET from Secrets Manager.',
            'Let\'s look at the token generation code in src/auth/tokenService.ts.',
            'The fix is to use Date.now() in milliseconds consistently rather than mixing seconds and milliseconds in the expiresIn calculation. PLAT-133 can be closed after AUTH-2847 lands.',
        ]);

        const items = extractWorkItemsFromSession(title, messages);
        assert.ok(items.includes('AUTH-2847'), `Missing AUTH-2847: ${items.join(', ')}`);
        assert.ok(items.includes('PLAT-133'), `Missing PLAT-133: ${items.join(', ')}`);
    });

    test('PR review session extracts GitHub issue references from commit messages', () => {
        const title = 'Reviewing PR for the session indexer refactor';
        const messages = makeMessages([
            'This PR resolves #312 (the full re-index on every file change bug). It also partially addresses #298.',
            'Good — make sure #312 is in the commit message too so GitHub auto-closes it on merge.',
            'Done. Commit message: "fix: debounce file watcher events to prevent full re-index Fixes #312"',
        ]);

        const items = extractWorkItemsFromSession(title, messages);
        assert.ok(items.some(i => i.includes('312')), `Missing #312: ${items.join(', ')}`);
        assert.ok(items.some(i => i.includes('298')), `Missing #298: ${items.join(', ')}`);
    });

    test('standup conversation: multiple tickets across different services', () => {
        const title = 'Daily standup context — May sprint';
        const messages = makeMessages([
            'Yesterday: finished INFRA-9901 (ECS task definition update). Today: starting INFRA-9912 (CloudWatch alarm thresholds). Blocked: INFRA-9908 depends on INFRA-9901 being deployed first.',
            'INFRA-9901 is deployed to staging. You should be unblocked for INFRA-9908. INFRA-9912 can run in parallel.',
        ]);

        const items = extractWorkItemsFromSession(title, messages);
        assert.ok(items.includes('INFRA-9901'), `Missing INFRA-9901: ${items.join(', ')}`);
        assert.ok(items.includes('INFRA-9912'), `Missing INFRA-9912: ${items.join(', ')}`);
        assert.ok(items.includes('INFRA-9908'), `Missing INFRA-9908: ${items.join(', ')}`);
    });

    test('no false positives in a session with only code discussion', () => {
        const title = 'Optimizing a binary search implementation';
        const messages = makeMessages([
            'Here is my binary search: the loop goes from index 0 to array.length. Is O(log n) time correct?',
            'Yes, O(log n) is correct for binary search. The key is that each iteration halves the search space.',
            'What about space complexity? I have a recursive version in my repo too.',
        ]);

        const items = extractWorkItemsFromSession(title, messages);
        // No JIRA/GitHub patterns in this conversation
        assert.strictEqual(items.length, 0, `Expected no work items in code-only conversation, got: ${items.join(', ')}`);
    });

    test('session with only a title containing a ticket', () => {
        const items = extractWorkItemsFromSession('BACKEND-7731 debug websocket reconnection', []);
        assert.ok(items.includes('BACKEND-7731'), `Missing BACKEND-7731: ${items.join(', ')}`);
    });

});
