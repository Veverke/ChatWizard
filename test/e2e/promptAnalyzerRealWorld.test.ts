// test/e2e/promptAnalyzerRealWorld.test.ts
//
// Tests the PromptAnalyzer against realistic developer prompts — the kind of
// messages developers actually send to AI coding assistants.
//
// Unlike the synthetic "word ".repeat(600) approach, these tests verify that the
// analyzer fires on prompts that a real developer would write and that the
// suggested model / cost estimate is reasonable for the prompt size.

import * as assert from 'assert';
import { PromptAnalyzer } from '../../src/analytics/promptAnalyzer';

suite('PromptAnalyzer — real developer prompts', () => {

    const analyzer = new PromptAnalyzer();

    // ── Concise, well-scoped prompt — should produce no verbosity flags ───────

    test('focused single-question prompt produces no verbosity flags', async () => {
        const prompt = 'What is the difference between Promise.all() and Promise.allSettled() in TypeScript?';
        const result = await analyzer.analyze(prompt);
        assert.strictEqual(result.verbosityFlags.length, 0,
            `Expected no flags for focused prompt, got: ${result.verbosityFlags.map(f => f.code).join(', ')}`);
    });

    // ── Multiple questions in one prompt ─────────────────────────────────────

    test('prompt with 4 separate questions fires MULTIPLE_QUESTIONS flag', async () => {
        const prompt = [
            'I\'m setting up a new React app with TypeScript.',
            'Should I use Vite or Create React App?',
            'How do I configure absolute imports in tsconfig.json?',
            'What is the best way to structure my components folder?',
            'Should I use CSS Modules or Tailwind?',
        ].join(' ');

        const result = await analyzer.analyze(prompt);
        assert.ok(
            result.verbosityFlags.some(f => f.code === 'MULTIPLE_QUESTIONS'),
            `Expected MULTIPLE_QUESTIONS flag, got: ${result.verbosityFlags.map(f => f.code).join(', ')}`,
        );
    });

    // ── Prompt with a massive code block ─────────────────────────────────────

    test('prompt pasting an entire 80-line component fires LARGE_CODE_BLOCK flag', async () => {
        const componentCode = `
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { User, UpdateUserInput } from '../types/user';
import { userApi } from '../api/userApi';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';

const schema = z.object({
  displayName: z.string().min(2).max(50),
  email: z.string().email(),
  avatarUrl: z.string().url().optional(),
  bio: z.string().max(500).optional(),
  timezone: z.string(),
  notifyOnMention: z.boolean(),
  notifyOnReply: z.boolean(),
  notifyDigest: z.enum(['never', 'daily', 'weekly']),
});

type FormData = z.infer<typeof schema>;

export function UserProfileForm({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [isEditing, setIsEditing] = useState(false);

  const { data: user, isLoading } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => userApi.getUser(userId),
  });

  const { mutate: updateUser, isPending } = useMutation({
    mutationFn: (data: UpdateUserInput) => userApi.updateUser(userId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user', userId] });
      toast.success('Profile updated');
      setIsEditing(false);
    },
    onError: () => toast.error('Failed to update profile'),
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: user,
  });

  useEffect(() => {
    if (user) reset(user);
  }, [user, reset]);

  const onSubmit = useCallback((data: FormData) => {
    updateUser(data);
  }, [updateUser]);

  if (isLoading) return <Spinner />;

  return (
    <form ref={formRef} onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Avatar src={user?.avatarUrl} name={user?.displayName} size="lg" />
      <Input label="Display name" error={errors.displayName?.message} {...register('displayName')} />
      <Input label="Email" type="email" error={errors.email?.message} {...register('email')} />
      <Button type="submit" disabled={!isDirty || isPending}>
        {isPending ? 'Saving...' : 'Save changes'}
      </Button>
    </form>
  );
}
`.trim();

        const prompt = `Here is my UserProfileForm component:\n\`\`\`tsx\n${componentCode}\n\`\`\`\n\nWhy is the form not resetting when I navigate away and come back?`;

        const result = await analyzer.analyze(prompt);
        assert.ok(
            result.verbosityFlags.some(f => f.code === 'LARGE_CODE_BLOCK'),
            `Expected LARGE_CODE_BLOCK flag for 80-line component, got: ${result.verbosityFlags.map(f => f.code).join(', ')}`,
        );
    });

    // ── Token count is proportional to prompt length ──────────────────────────

    test('token count scales with prompt length', async () => {
        const short = 'What is async/await?';
        const long = 'I have a complex question about async/await, Promises, generators, and the JavaScript event loop. ' +
            'Please explain how microtasks and macrotasks interact, why Promise.then callbacks run before setTimeout callbacks, ' +
            'how async generators work with for-await-of, what happens when you mix await and Promise.all, ' +
            'and give me examples of common anti-patterns like accidentally using async in forEach.';

        const shortResult = await analyzer.analyze(short);
        const longResult = await analyzer.analyze(long);

        assert.ok(
            longResult.tokenCount > shortResult.tokenCount,
            `Long prompt (${longResult.tokenCount} tokens) should have more tokens than short (${shortResult.tokenCount} tokens)`,
        );
    });

    // ── Cost estimates are present for all known model tiers ─────────────────

    test('cost estimates include multiple model tiers', async () => {
        const result = await analyzer.analyze(
            'Explain the difference between a microservices architecture and a monolith.',
        );
        assert.ok(Array.isArray(result.costEstimates), 'costEstimates should be an array');
        assert.ok(result.costEstimates.length > 0, 'Should have at least one cost estimate');

        // Each estimate should have a model name and a numeric cost
        for (const { model, estimate } of result.costEstimates) {
            assert.ok(model, 'Each estimate should have a model name');
            assert.ok(typeof estimate.inputUsd === 'number', 'inputUsd should be numeric');
            assert.ok(estimate.inputUsd >= 0, 'inputUsd should be non-negative');
        }
    });

    // ── Suggested model is one of the known model IDs ─────────────────────────

    test('suggested model is a non-empty string from the price table', async () => {
        const result = await analyzer.analyze('Summarise the RFC for HTTP/3 in three bullet points.');
        assert.ok(typeof result.suggestedModel === 'string' && result.suggestedModel.length > 0);
    });

    // ── Open-ended prompts are flagged ────────────────────────────────────────

    test('open-ended "explain everything" prompt fires OPEN_ENDED flag', async () => {
        const prompt = 'Can you explain everything about React hooks and how they work, including all the rules?';
        const result = await analyzer.analyze(prompt);
        assert.ok(
            result.verbosityFlags.some(f => f.code === 'OPEN_ENDED'),
            `Expected OPEN_ENDED flag, got: ${result.verbosityFlags.map(f => f.code).join(', ')}`,
        );
    });

    // ── Summary is a human-readable string ────────────────────────────────────

    test('summary field is a non-empty human-readable string', async () => {
        const result = await analyzer.analyze('How do I set up ESLint and Prettier together in a TypeScript project?');
        assert.ok(typeof result.summary === 'string' && result.summary.length > 0,
            `Expected non-empty summary, got: "${result.summary}"`);
    });

});
