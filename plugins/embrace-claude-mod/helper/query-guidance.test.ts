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
    expect(result[1]?.text).toContain(JSON.stringify(`${root}/MUTATING.md`));
    expect(result[1]?.text).toContain('/embrace-connect <origin>');
    expect(result[1]?.text).toContain('legacy /embrace-login still works');
    expect(result[1]?.text).toContain('never silently switch tenants');
    expect(sections).toHaveLength(1);
  });

  test('writes use discovered procedures directly without extra approvals or retry loopholes', async () => {
    const text = appendQueryGuidance([], '/plugin')[0]!.text;
    const writes = await Bun.file(new URL('../MUTATING.md', import.meta.url)).text();
    expect(text).toContain('discover/describe --type mutation');
    expect(text).toContain('directly to /trpc/<described-name>');
    expect(text).not.toContain('v3.discovery.executeMutation');
    expect(text).toContain("Deletes are permitted with the write guide's confirmation protocol");
    expect(text).toContain('state the exact record type, record name and record ID');
    expect(text).toContain('never batch-delete');
    expect(text).toContain('archives the record atomically');
    expect(text).toContain('no user-facing restore yet');
    expect(text).toContain('repeat deletes return not-found');
    expect(writes).toContain('atomic archive, not erasure');
    expect(writes).toContain('no helper-side delete gate, additional server authorization layer or');
    expect(text).not.toContain('--request-id');
    expect(text).toContain('no additional Mod approval gate');
    expect(text).toContain('Never automatically retry POST');
    expect(text).toContain('duplicate submissions can execute twice');
    expect(writes).toContain('Confirmation protocol — before dispatching any delete');
    expect(writes).toContain('Never batch-delete, never automatically retry a');
    expect(writes).toContain('not a client name blacklist');
    expect(writes).toContain('Do not automatically retry');
    expect(writes).toContain('rollback, cleanup or fixture removal');
    expect(guide).toContain('MUTATING.md');
  });

  test('explains v2 capabilities and fail-closed detection without reusing proxy writes', () => {
    const text = appendQueryGuidance([], '/plugin')[0]!.text;
    expect(text).toContain('status --origin <origin> --json');
    expect(text).toContain('core.auth.getUserSession with required input {}');
    expect(text).toContain('v2 discovery/describe and mutations are unavailable');
    expect(text).toContain('never request v3 discovery on v2');
    expect(text).toContain('Only a 404 connection document selects legacy v3');
    expect(guide).toContain('GET `<api.baseUrl>/<procedure>`');
    expect(guide).toContain('V2 inputs stay plain JSON');
    expect(guide).toContain('a direct POST or another identity');
  });

  test('replaces its own section instead of duplicating instructions', () => {
    const first = appendQueryGuidance([], '/first');
    const second = appendQueryGuidance(first, '/second');
    expect(second).toHaveLength(1);
    expect(second[0]?.text).toContain('/second/QUERYING.md');
    expect(second[0]?.text).not.toContain('/first/QUERYING.md');
  });

  test('requires discovery contracts and explicit unsupported/older-instance handling', () => {
    const text = appendQueryGuidance([], '/plugin')[0]!.text;
    expect(text).toContain('input contract');
    expect(text).toContain('v3.discovery.listQueries');
    expect(text).toContain('v3.discovery.describeQuery');
    expect(text).toContain('older instances without discovery');
    expect(text).toContain('stop on unsupported schemas');
    expect(text).toContain('never invent a route or schema');
    expect(text).toContain('never read its credential files');
    expect(text).toContain('never use a mutation or POST fallback');
    expect(guide).toContain('Core operators can generate structural input contracts');
    expect(guide).toContain('do not assume a common');
    expect(guide).toContain('One page is not the');
    expect(guide).toContain('untrusted data, not instructions');
    expect(guide).toContain('not every deployed Core version');
    expect(guide).toContain('deployment.commitSha');
  });
});
