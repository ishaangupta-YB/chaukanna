import {
  IsAuthorizedCommand,
  VerifiedPermissionsClient,
  type AttributeValue,
  type IsAuthorizedCommandInput,
} from '@aws-sdk/client-verifiedpermissions';
import { config } from './config';
import { forbidden } from './errors';
import { errorFields, log } from './log';

/**
 * Authorization, decided by Amazon Verified Permissions rather than by a branch in a route.
 *
 * Every sensitive read calls `requireAuthz`. The answer is a Cedar decision made against the
 * policies in `infra/lib/chaukanna-stack.ts`, and anything that is not an explicit ALLOW is a
 * 403 — including the call failing, which is default deny (CLAUDE.md product rule 5).
 */

/**
 * Bare Cedar action ids. The SDK takes the type and the id separately and quotes the id itself,
 * so `Chaukanna::Action::"ViewBand"` here would be sent as a literal, quotes and all.
 */
export const VP_ACTIONS = {
  VIEW_BAND: 'ViewBand',
  VIEW_TRANSCRIPT: 'ViewTranscript',
  SCHEDULE_DRILL: 'ScheduleDrill',
  TAKE_DRILL: 'TakeDrill',
} as const;

export const VP_ACTION_TYPE = 'Chaukanna::Action';

export type VPAction = (typeof VP_ACTIONS)[keyof typeof VP_ACTIONS];

/** Only the attribute kinds the schema declares: strings and booleans. */
type VPAttributes = Record<string, string | boolean | undefined>;

export interface VPPrincipal {
  type: 'Member';
  id: string;
  attributes: VPAttributes;
}

export interface VPResource {
  type: 'Drill' | 'Member';
  id: string;
  attributes: VPAttributes;
}

let vpClient: VerifiedPermissionsClient | null = null;

function getVPClient(): VerifiedPermissionsClient {
  if (!vpClient) {
    vpClient = new VerifiedPermissionsClient({ region: config.region });
  }
  return vpClient;
}

/**
 * Cedar is typed. A Boolean attribute sent as the string "false" is both a type error under
 * STRICT validation and, worse, truthy-looking, so booleans go over the wire as booleans.
 */
function toAttributes(attributes: VPAttributes): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    out[name] = typeof value === 'boolean' ? { boolean: value } : { string: value };
  }
  return out;
}

/**
 * Entity types are namespace qualified on the wire. The schema is registered under the
 * `Chaukanna` namespace, so a bare `Member` is not a type the policy store knows about.
 */
function toEntity(entity: VPPrincipal | VPResource): IsAuthorizedCommandInput['principal'] {
  return { entityType: `Chaukanna::${entity.type}`, entityId: entity.id };
}

/** Throws a 403 unless Verified Permissions returns an explicit ALLOW. */
export async function requireAuthz(
  principal: VPPrincipal,
  action: VPAction,
  resource: VPResource,
): Promise<void> {
  const command = new IsAuthorizedCommand({
    policyStoreId: config.policyStoreId,
    principal: toEntity(principal),
    action: { actionType: VP_ACTION_TYPE, actionId: action },
    resource: toEntity(resource),
    entities: {
      entityList: [
        { identifier: toEntity(principal), attributes: toAttributes(principal.attributes) },
        { identifier: toEntity(resource), attributes: toAttributes(resource.attributes) },
      ],
    },
  });

  /*
   * Only the call itself is inside the try. A DENY is not an exception the catch has to tell
   * apart from an SDK failure by reading its message: it is decided below, after the call.
   */
  let decision: string | undefined;
  try {
    decision = (await getVPClient().send(command)).decision;
  } catch (error) {
    log.error('authz.unavailable', { action, resourceType: resource.type, resourceId: resource.id, ...errorFields(error) });
    throw forbidden('authz_unavailable');
  }

  if (decision !== 'ALLOW') {
    log.info('authz.deny', { action, resourceType: resource.type, resourceId: resource.id, principalId: principal.id, decision: decision ?? 'none' });
    throw forbidden('authz_denied');
  }
}

/*
 * Builders. Every attribute the Cedar policies read is supplied here on every call, because the
 * schema declares those attributes required and an entity that omits one is rejected outright.
 */

export function buildGuardianPrincipal(guardianSub: string, householdId: string): VPPrincipal {
  return { type: 'Member', id: guardianSub, attributes: { memberId: guardianSub, householdId, status: 'active' } };
}

export function buildLearnerPrincipal(memberId: string, householdId: string, status = 'active'): VPPrincipal {
  return { type: 'Member', id: memberId, attributes: { memberId, householdId, status } };
}

/** `transcriptSharing` is the learner's own switch, carried from their member row. */
export function buildDrillResource(
  drillId: string,
  householdId: string,
  memberId: string,
  transcriptSharing: boolean,
): VPResource {
  return { type: 'Drill', id: drillId, attributes: { drillId, householdId, memberId, transcriptSharing } };
}

export function buildMemberResource(memberId: string, householdId: string, status: string): VPResource {
  return { type: 'Member', id: memberId, attributes: { memberId, householdId, status } };
}
