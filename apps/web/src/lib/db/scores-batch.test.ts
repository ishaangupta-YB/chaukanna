import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading several scores at once, under a role that may not be allowed to.
 *
 * `dynamodb:BatchGetItem` is a separate IAM action from `dynamodb:GetItem` and is not implied by
 * it. A role granted the one and not the other looks perfectly healthy until a household has its
 * first drill, and then every guardian screen that lists outcomes throws at once — which is
 * exactly how this was found, on a deployed dashboard rather than in a test.
 */

const send = vi.hoisted(() => vi.fn());
const commands = vi.hoisted(() => ({ batch: [] as unknown[], get: [] as unknown[] }));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  BatchGetCommand: class {
    readonly kind = 'batch';
    constructor(readonly input: unknown) {
      commands.batch.push(input);
    }
  },
  GetCommand: class {
    readonly kind = 'get';
    constructor(readonly input: { Key: { pk: string } }) {
      commands.get.push(input);
    }
  },
}));

vi.mock('./client', () => ({
  ddb: () => ({ send }),
  table: () => 'chaukanna',
  keys: { score: (drillId: string) => ({ pk: `DRILL#${drillId}`, sk: 'SCORE' }) },
}));

const { listScores } = await import('./scores');

/** The row the scoring pipeline actually writes; a partial one would not parse. */
function row(drillId: string) {
  return {
    pk: `DRILL#${drillId}`,
    sk: 'SCORE',
    entity: 'Score',
    drillId,
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    scheduledAt: '2026-09-21T06:00:00.000Z',
    language: 'hi-IN',
    status: 'scored',
    score: 35,
    band: 'at_risk',
    rubricVersion: 'prd.v1',
    judgePromptVersion: 'score.judge.v1',
    judgeModelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    guardrailId: 'gr-123',
    guardrailVersion: 'DRAFT',
    createdAt: '2026-09-21T06:04:30.000Z',
  };
}

const denied = () => Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });

beforeEach(() => {
  send.mockReset();
  commands.batch = [];
  commands.get = [];
});

describe('listScores', () => {
  it('reads them in one BatchGetItem when the role may', async () => {
    send.mockResolvedValue({ Responses: { chaukanna: [row('aaaaaaaabbbbbbbbcccc'), row('bbbbbbbbccccddddeeee')] } });

    const found = await listScores(['aaaaaaaabbbbbbbbcccc', 'bbbbbbbbccccddddeeee']);

    expect([...found.keys()].sort()).toEqual(['aaaaaaaabbbbbbbbcccc', 'bbbbbbbbccccddddeeee']);
    expect(commands.batch).toHaveLength(1);
    expect(commands.get).toHaveLength(0);
  });

  it('falls back to one GetItem per drill when BatchGetItem is denied', async () => {
    send.mockImplementation(async (command: { kind: string; input: { Key: { pk: string } } }) => {
      if (command.kind === 'batch') throw denied();
      const drillId = command.input.Key.pk.replace('DRILL#', '');
      return { Item: drillId === 'bbbbbbbbccccddddeeee' ? row(drillId) : undefined };
    });

    const found = await listScores(['aaaaaaaabbbbbbbbcccc', 'bbbbbbbbccccddddeeee']);

    // The first drill has no score row yet, which is the normal answer while it is being scored.
    expect([...found.keys()]).toEqual(['bbbbbbbbccccddddeeee']);
    expect(commands.get).toHaveLength(2);
  });

  it('still throws when the failure is not a missing permission', async () => {
    send.mockRejectedValue(Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' }));
    await expect(listScores(['aaaaaaaabbbbbbbbcccc'])).rejects.toThrow('boom');
    expect(commands.get).toHaveLength(0);
  });

  it('asks about each drill once, however many times it was listed', async () => {
    send.mockResolvedValue({ Responses: { chaukanna: [] } });
    await listScores(['aaaaaaaabbbbbbbbcccc', 'aaaaaaaabbbbbbbbcccc', 'bbbbbbbbccccddddeeee']);
    expect((commands.batch[0] as { RequestItems: Record<string, { Keys: unknown[] }> }).RequestItems.chaukanna.Keys).toHaveLength(2);
  });
});
