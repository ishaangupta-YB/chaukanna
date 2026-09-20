import {
  ActionAfterCompletion,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import { config } from './config';
import { log } from './log';
import { toSchedulerExpression } from './schedule';

/**
 * One time EventBridge schedules, one per drill. This module is the only place that knows the
 * schedule naming convention, because that name is also the authorization boundary: the compute
 * role may create and delete `chaukanna-drill-*` and nothing else.
 */

let client: SchedulerClient | null = null;

function scheduler(): SchedulerClient {
  if (!client) client = new SchedulerClient({ region: config.region });
  return client;
}

/** Derivable from the drill id alone, so cancellation never needs a stored name. */
export function scheduleNameFor(drillId: string): string {
  return `chaukanna-drill-${drillId}`;
}

/**
 * Creates the schedule that will ring this drill.
 *
 * `ActionAfterCompletion: DELETE` is what keeps the schedule list readable — without it every
 * drill ever run leaves a spent schedule behind. It does not replace explicit deletion on
 * cancellation: a cancelled drill's schedule has not completed, so nothing would ever remove it.
 */
export async function createDrillSchedule(input: {
  drillId: string;
  memberId: string;
  at: Date;
  timeZone: string;
}): Promise<string> {
  const name = scheduleNameFor(input.drillId);
  await scheduler().send(
    new CreateScheduleCommand({
      Name: name,
      // Local wall clock in the learner's zone, paired with the zone itself. A trailing `Z` here
      // is the classic bug: Scheduler would read it as a literal and the drill would ring five and
      // a half hours out. `toSchedulerExpression` is the only place that format is written.
      ScheduleExpression: toSchedulerExpression(input.at, input.timeZone),
      ScheduleExpressionTimezone: input.timeZone,
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      ActionAfterCompletion: ActionAfterCompletion.DELETE,
      Description: 'Chaukanna practice drill',
      Target: {
        Arn: config.ringLambdaArn,
        RoleArn: config.schedulerInvokeRoleArn,
        // The Lambda re-reads everything it needs from the table. This payload is two ids, never
        // a name, a language or anything else a person would mind being in a schedule listing.
        Input: JSON.stringify({ drillId: input.drillId, memberId: input.memberId }),
      },
    }),
  );
  return name;
}

/**
 * Deletes a drill's schedule. Silent when it is already gone, which is the common case rather
 * than the exception: the schedule deletes itself once it has fired, and cancelling a drill that
 * rang a second ago is exactly the race this whole design expects.
 */
export async function deleteDrillSchedule(drillId: string): Promise<boolean> {
  try {
    await scheduler().send(new DeleteScheduleCommand({ Name: scheduleNameFor(drillId) }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') return false;
    // A schedule we cannot delete is not a reason to leave the drill live. The caller marks the
    // row cancelled regardless, and the ring Lambda re-checks consent before it rings anything.
    log.warn('schedule.delete_failed', { drillId, errorName: error instanceof Error ? error.name : 'unknown' });
    return false;
  }
}
