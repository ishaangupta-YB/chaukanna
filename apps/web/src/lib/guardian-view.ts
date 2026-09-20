import {
  authorizedQueries,
  buildDrillResource,
  buildGuardianPrincipal,
  isAllowed,
  VP_ACTIONS,
  type VPQuery,
} from './authz';
import type { Drill, Member } from './db';

/**
 * What a guardian's own screens are allowed to show, decided by Cedar rather than by the page.
 *
 * The dashboard and the audit log are server components, so they are the API for their own data:
 * "the API returns the fields the caller is allowed to see, it does not return everything and
 * hide it in the UI" (phase 6, code practices). Both of them read drills, so both of them ask
 * `ViewBand` about every drill they are about to render, in one batched call per member.
 *
 * `available: false` is not the same as an empty list and the screens must not render it as one.
 * An empty list means this member has had no practice calls; `available: false` means Verified
 * Permissions could not be reached, so nothing is authorized and the screen says exactly that
 * instead of quietly reporting "no practice calls" for a household that has had several.
 */

export interface AuthorizedDrills {
  drills: Drill[];
  available: boolean;
}

/**
 * The drills of `member` this guardian may see the outcome of.
 *
 * Default deny survives every failure mode: a drill is kept only on an explicit ALLOW, and a
 * failure of the call itself returns no drills at all rather than falling back to the raw list.
 */
export async function authorizedDrills(
  guardianSub: string,
  guardianHouseholdId: string,
  member: Member,
  drills: Drill[],
): Promise<AuthorizedDrills> {
  if (drills.length === 0) return { drills: [], available: true };

  const principal = buildGuardianPrincipal(guardianSub, guardianHouseholdId);
  const queries: VPQuery[] = drills.map((drill) => ({
    action: VP_ACTIONS.VIEW_BAND,
    // The household on the resource is the drill row's own, never the guardian's: the Cedar
    // `when` has to compare two values that came from different places to mean anything.
    resource: buildDrillResource(drill.drillId, drill.householdId, drill.memberId, member.transcriptSharing),
  }));

  try {
    const allowed = await authorizedQueries(principal, queries);
    return {
      drills: drills.filter((drill) => isAllowed(allowed, VP_ACTIONS.VIEW_BAND, drill.drillId)),
      available: true,
    };
  } catch {
    return { drills: [], available: false };
  }
}
