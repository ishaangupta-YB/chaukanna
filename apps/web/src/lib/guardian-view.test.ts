import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drill, Member } from './db';

/**
 * The guardian's list screens, authorized drill by drill.
 *
 * Phase 6 task 2 is "authorize every sensitive read", and a dashboard is a read of many drills at
 * once. What is tested here is the part that a per-request helper cannot cover on its own: that a
 * batched answer is attributed to the right drill, that a drill nobody permitted is dropped, and
 * that a failure of the call is distinguishable from a household that has simply never practised.
 */

const sdk = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class {
    send = sdk.send;
  },
  IsAuthorizedCommand: class {
    constructor(readonly input: unknown) {}
  },
  BatchIsAuthorizedCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

process.env.AWS_REGION = 'ap-south-1';
process.env.POLICY_STORE_ID = 'test-policy-store';

const { authorizedDrills } = await import('./guardian-view');

const HOUSEHOLD = '0123456789abcdef0123';
const OTHER_HOUSEHOLD = 'fedcba9876543210fedc';
const LEARNER = 'abcdef0123456789abcd';
const GUARDIAN_SUB = 'guardian-sub-1';

interface BatchRequest {
  principal: { entityType: string; entityId: string };
  action: { actionType: string; actionId: string };
  resource: { entityType: string; entityId: string };
}
interface SingleInput {
  policyStoreId: string;
  principal: { entityType: string; entityId: string };
  action: { actionType: string; actionId: string };
  resource: { entityType: string; entityId: string };
}
interface BatchInput {
  policyStoreId: string;
  entities: { entityList: { identifier: { entityType: string; entityId: string } }[] };
  requests: BatchRequest[];
}

function member(overrides: Partial<Member> = {}): Member {
  return {
    memberId: LEARNER,
    householdId: HOUSEHOLD,
    displayName: 'Dadi',
    language: 'hi-IN',
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    transcriptSharing: false,
    ...overrides,
  };
}

function drill(drillId: string, householdId = HOUSEHOLD): Drill {
  return {
    drillId,
    memberId: LEARNER,
    householdId,
    scenarioId: 'digital_arrest_v1',
    language: 'hi-IN',
    state: 'ended',
    scheduledAt: '2026-09-21T03:35:00.000Z',
    createdAt: '2026-09-21T03:30:00.000Z',
    updatedAt: '2026-09-21T03:40:00.000Z',
    createdBy: 'guardian',
    maxSeconds: 360,
  };
}

/** The deployed `ViewBand` permit, evaluated against the request the code actually built. */
function viewBand(input: BatchInput) {
  return {
    results: input.requests.map((request) => ({
      request,
      // The guardian's household is the one on the principal entity; the drill's is its own.
      decision: request.resource.entityId.startsWith('same') ? 'ALLOW' : 'DENY',
    })),
  };
}

let sent: BatchInput[] = [];

beforeEach(() => {
  sent = [];
  sdk.send.mockReset();
  sdk.send.mockImplementation(async (command: { input: BatchInput }) => {
    sent.push(command.input);
    return viewBand(command.input);
  });
});

describe('authorizedDrills', () => {
  it('keeps only the drills Cedar permitted, and attributes each answer to its own drill', async () => {
    const result = await authorizedDrills(GUARDIAN_SUB, HOUSEHOLD, member(), [
      drill('same-1'),
      drill('other-1', OTHER_HOUSEHOLD),
      drill('same-2'),
    ]);

    expect(result.available).toBe(true);
    expect(result.drills.map((d) => d.drillId)).toEqual(['same-1', 'same-2']);
  });

  it('asks ViewBand about every drill in one call, under the namespaced entity types', async () => {
    await authorizedDrills(GUARDIAN_SUB, HOUSEHOLD, member(), [drill('same-1'), drill('same-2')]);

    expect(sdk.send).toHaveBeenCalledOnce();
    expect(sent[0].requests).toHaveLength(2);
    expect(sent[0].requests.map((r) => r.action.actionId)).toEqual(['ViewBand', 'ViewBand']);
    expect(sent[0].requests[0].principal).toEqual({ entityType: 'Chaukanna::Member', entityId: GUARDIAN_SUB });
    expect(sent[0].requests[0].resource.entityType).toBe('Chaukanna::Drill');
    // The principal is contributed once however many drills reference it: a repeated identifier
    // in `entities` is rejected by the service as a duplicate.
    expect(sent[0].entities.entityList.map((e) => e.identifier.entityId)).toEqual([
      GUARDIAN_SUB,
      'same-1',
      'same-2',
    ]);
  });

  it('chunks past the 30 request batch limit rather than sending an oversized call', async () => {
    const drills = Array.from({ length: 31 }, (_, i) => drill(`same-${i}`));
    const result = await authorizedDrills(GUARDIAN_SUB, HOUSEHOLD, member(), drills);

    expect(sdk.send).toHaveBeenCalledTimes(2);
    expect(sent[0].requests).toHaveLength(30);
    expect(sent[1].requests).toHaveLength(1);
    expect(result.drills).toHaveLength(31);
  });

  it('drops a drill the service returned an unexpected decision for', async () => {
    sdk.send.mockResolvedValueOnce({
      results: [{ request: { action: { actionId: 'ViewBand' }, resource: { entityId: 'same-1' } } }],
    });
    const result = await authorizedDrills(GUARDIAN_SUB, HOUSEHOLD, member(), [drill('same-1')]);
    expect(result).toEqual({ drills: [], available: true });
  });

  it('falls back to one question at a time when the role may not call BatchIsAuthorized', async () => {
    // The compute role is granted `IsAuthorized`; `BatchIsAuthorized` is a separate action and
    // is not implied by it. A guardian must not lose their own dashboard over that.
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    sdk.send.mockReset();
    sdk.send.mockImplementation(async (command: { input: BatchInput | SingleInput }) => {
      if ('requests' in command.input) throw denied;
      // The single-request shape, answered by the same rule the batch fake uses.
      const single = command.input as SingleInput;
      return { decision: single.resource.entityId.startsWith('same') ? 'ALLOW' : 'DENY' };
    });

    const result = await authorizedDrills(GUARDIAN_SUB, HOUSEHOLD, member(), [
      drill('same-1'),
      drill('other-1', OTHER_HOUSEHOLD),
      drill('same-2'),
    ]);

    // Identical answers to the batch path: the fallback changes the transport, not the decision.
    expect(result.available).toBe(true);
    expect(result.drills.map((d) => d.drillId)).toEqual(['same-1', 'same-2']);
    // One batch attempt, then one IsAuthorized per drill.
    expect(sdk.send).toHaveBeenCalledTimes(4);
  });

  it('still reports unavailable when the fallback is not applicable', async () => {
    sdk.send.mockRejectedValueOnce(new Error('ThrottlingException'));
    const result = await authorizedDrills(GUARDIAN_SUB, HOUSEHOLD, member(), [drill('same-1')]);
    // Default deny: no drills. But `available: false` is what stops the screen reporting this
    // as "no practice calls yet" for a household that has had several.
    expect(result).toEqual({ drills: [], available: false });
  });

  it('does not call Verified Permissions at all for a member with no drills', async () => {
    expect(await authorizedDrills(GUARDIAN_SUB, HOUSEHOLD, member(), [])).toEqual({
      drills: [],
      available: true,
    });
    expect(sdk.send).not.toHaveBeenCalled();
  });
});
