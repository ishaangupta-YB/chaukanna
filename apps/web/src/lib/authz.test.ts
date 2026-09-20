import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from './errors';

/**
 * Authorization, tested two ways at once.
 *
 * Verified Permissions is faked, but the fake is not a rubber stamp: it evaluates the same Cedar
 * statements that `infra/lib/chaukanna-stack.ts` deploys, against the request the code actually
 * built. So a test fails either because a decision is wrong or because the request was malformed
 * — a quoted action id, a boolean sent as a string — which is the bug class that would otherwise
 * only surface against the real service.
 */

interface SentAttribute {
  string?: string;
  boolean?: boolean;
}
type SentAttributes = Record<string, SentAttribute>;
interface SentInput {
  policyStoreId: string;
  principal: { entityType: string; entityId: string };
  action: { actionType: string; actionId: string };
  resource: { entityType: string; entityId: string };
  entities: { entityList: { identifier: { entityType: string; entityId: string }; attributes: SentAttributes }[] };
}

const sent: SentInput[] = [];
const sdk = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class {
    send = sdk.send;
  },
  IsAuthorizedCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

process.env.AWS_REGION = 'ap-south-1';
process.env.POLICY_STORE_ID = 'test-policy-store';

const {
  buildDrillResource,
  buildGuardianPrincipal,
  buildLearnerPrincipal,
  buildMemberResource,
  requireAuthz,
  VP_ACTIONS,
} = await import('./authz');

/** Attributes as Cedar would see them: strings and booleans, never a stringified boolean. */
function values(attributes: SentAttributes): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value.boolean === 'boolean') out[name] = value.boolean;
    else if (typeof value.string === 'string') out[name] = value.string;
    else throw new Error(`attribute ${name} is neither a string nor a boolean`);
  }
  return out;
}

/** The five deployed statements, evaluated in Cedar's order: default deny, forbid wins. */
function cedar(input: SentInput): 'ALLOW' | 'DENY' {
  const entity = (id: string) => {
    const found = input.entities.entityList.find((e) => e.identifier.entityId === id);
    if (!found) throw new Error(`entity ${id} was not sent`);
    return values(found.attributes);
  };
  const principal = entity(input.principal.entityId);
  const resource = entity(input.resource.entityId);
  const action = input.action.actionId;

  let permitted = false;
  if (action === 'ViewBand') permitted = resource.householdId === principal.householdId;
  if (action === 'ViewTranscript') {
    permitted =
      (resource.householdId === principal.householdId && resource.transcriptSharing === true) ||
      resource.memberId === principal.memberId;
  }
  if (action === 'ScheduleDrill') permitted = resource.householdId === principal.householdId;
  if (action === 'TakeDrill') permitted = resource.memberId === principal.memberId;

  const forbidden = action === 'ScheduleDrill' && resource.status === 'paused';
  return permitted && !forbidden ? 'ALLOW' : 'DENY';
}

beforeEach(() => {
  sent.length = 0;
  sdk.send.mockReset();
  sdk.send.mockImplementation(async (command: { input: SentInput }) => {
    sent.push(command.input);
    return { decision: cedar(command.input) };
  });
});

const HOUSEHOLD = '0123456789abcdef0123';
const OTHER_HOUSEHOLD = 'fedcba9876543210fedc';
const LEARNER = 'abcdef0123456789abcd';
const GUARDIAN_SUB = 'guardian-sub-1';
const DRILL = 'drill0123456789abcde';

const guardian = buildGuardianPrincipal(GUARDIAN_SUB, HOUSEHOLD);
const learner = buildLearnerPrincipal(LEARNER, HOUSEHOLD);
const stranger = buildGuardianPrincipal('stranger-sub', OTHER_HOUSEHOLD);
const drill = (transcriptSharing: boolean) => buildDrillResource(DRILL, HOUSEHOLD, LEARNER, transcriptSharing);

describe('requireAuthz, the six cases the safety claims rest on', () => {
  const cases = [
    { name: 'guardian views band', principal: guardian, action: VP_ACTIONS.VIEW_BAND, resource: drill(false), allowed: true },
    { name: 'guardian views transcript without sharing', principal: guardian, action: VP_ACTIONS.VIEW_TRANSCRIPT, resource: drill(false), allowed: false },
    { name: 'guardian views transcript with sharing', principal: guardian, action: VP_ACTIONS.VIEW_TRANSCRIPT, resource: drill(true), allowed: true },
    { name: 'guardian schedules for a paused learner', principal: guardian, action: VP_ACTIONS.SCHEDULE_DRILL, resource: buildMemberResource(LEARNER, HOUSEHOLD, 'paused'), allowed: false },
    { name: 'guardian schedules for an active learner', principal: guardian, action: VP_ACTIONS.SCHEDULE_DRILL, resource: buildMemberResource(LEARNER, HOUSEHOLD, 'active'), allowed: true },
    { name: 'learner views own transcript', principal: learner, action: VP_ACTIONS.VIEW_TRANSCRIPT, resource: drill(false), allowed: true },
    { name: 'stranger views a band', principal: stranger, action: VP_ACTIONS.VIEW_BAND, resource: drill(true), allowed: false },
    { name: 'stranger views a transcript', principal: stranger, action: VP_ACTIONS.VIEW_TRANSCRIPT, resource: drill(true), allowed: false },
    { name: 'stranger schedules a drill', principal: stranger, action: VP_ACTIONS.SCHEDULE_DRILL, resource: buildMemberResource(LEARNER, HOUSEHOLD, 'active'), allowed: false },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: ${c.allowed ? 'allow' : 'deny'}`, async () => {
      const call = requireAuthz(c.principal, c.action, c.resource);
      if (c.allowed) {
        await expect(call).resolves.toBeUndefined();
      } else {
        await expect(call).rejects.toMatchObject({ status: 403, code: 'authz_denied' });
      }
    });
  }
});

describe('the request that goes over the wire', () => {
  it('sends a bare action id under the Chaukanna::Action type, not a quoted Cedar literal', async () => {
    await requireAuthz(guardian, VP_ACTIONS.VIEW_BAND, drill(false));
    expect(sent[0].action).toEqual({ actionType: 'Chaukanna::Action', actionId: 'ViewBand' });
    expect(sent[0].action.actionId).not.toContain('"');
    expect(sent[0].policyStoreId).toBe('test-policy-store');
  });

  it('names the entity types the schema declares', async () => {
    await requireAuthz(guardian, VP_ACTIONS.SCHEDULE_DRILL, buildMemberResource(LEARNER, HOUSEHOLD, 'active'));
    expect(sent[0].principal).toEqual({ entityType: 'Chaukanna::Member', entityId: GUARDIAN_SUB });
    expect(sent[0].resource).toEqual({ entityType: 'Chaukanna::Member', entityId: LEARNER });
  });

  it('sends transcriptSharing as a Cedar Boolean, never as a string', async () => {
    await requireAuthz(guardian, VP_ACTIONS.VIEW_TRANSCRIPT, drill(false)).catch(() => undefined);
    const resource = sent[0].entities.entityList.find((e) => e.identifier.entityId === DRILL);
    expect(resource?.attributes.transcriptSharing).toEqual({ boolean: false });
    expect(resource?.attributes.householdId).toEqual({ string: HOUSEHOLD });
  });

  it('always supplies every attribute the policies read', async () => {
    await requireAuthz(guardian, VP_ACTIONS.VIEW_BAND, drill(true));
    const attributes = sent[0].entities.entityList.map((e) => Object.keys(e.attributes).sort());
    expect(attributes[0]).toEqual(['householdId', 'memberId', 'status']);
    expect(attributes[1]).toEqual(['drillId', 'householdId', 'memberId', 'transcriptSharing']);
  });
});

describe('default deny', () => {
  it('denies when the Verified Permissions call itself fails', async () => {
    sdk.send.mockRejectedValueOnce(new Error('ThrottlingException'));
    await expect(requireAuthz(guardian, VP_ACTIONS.VIEW_BAND, drill(true))).rejects.toMatchObject({
      status: 403,
      code: 'authz_unavailable',
    });
  });

  it('denies on an unexpected decision rather than treating it as an allow', async () => {
    sdk.send.mockResolvedValueOnce({});
    const error = await requireAuthz(learner, VP_ACTIONS.TAKE_DRILL, drill(true)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(403);
  });
});
