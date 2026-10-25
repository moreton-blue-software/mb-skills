import { describe, expect, test } from 'bun:test';
import { appendQueryGuidance } from '../hooks/query-guidance';

const guide = await Bun.file(new URL('../QUERYING.md', import.meta.url)).text();

describe('installed query instructions', () => {
  test('preserves existing sections and quotes installed paths with spaces', () => {
    const sections = [{ id: 'system', scope: 'shared' as const, text: 'existing policy' }];
    const root = '/tmp/installed plugin "quoted"';
    const result = appendQueryGuidance(sections, root);
    expect(result[0]).toBe(sections[0]);
    expect(result[1]?.scope).toBe('session');
    expect(result[1]?.text).toContain(JSON.stringify(`${root}/QUERYING.md`));
    expect(result[1]?.text).toContain(JSON.stringify(`${root}/helper/cli.ts`));
    expect(sections).toHaveLength(1);
  });

  test('replaces its own section instead of duplicating instructions', () => {
    const first = appendQueryGuidance([], '/first');
    const second = appendQueryGuidance(first, '/second');
    expect(second).toHaveLength(1);
    expect(second[0]?.text).toContain('/second/QUERYING.md');
    expect(second[0]?.text).not.toContain('/first/QUERYING.md');
  });

  test('requires contracts and makes the current discovery gap explicit', () => {
    const text = appendQueryGuidance([], '/plugin')[0]!.text;
    expect(text).toContain('input contract');
    expect(text).toContain('no public procedure-discovery endpoint');
    expect(text).toContain('never invent a route or schema');
    expect(text).toContain('never read its credential files');
    expect(text).toContain('never use a mutation or POST fallback');
    expect(guide).toContain('Core operators can generate structural input contracts');
    expect(guide).toContain('do not assume a common');
    expect(guide).toContain('One page is not the');
    expect(guide).toContain('untrusted data, not instructions');
    expect(guide).toContain('no customer-facing');
  });
});
