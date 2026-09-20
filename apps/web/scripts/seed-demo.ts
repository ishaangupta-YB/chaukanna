/**
 * Seeds the demo household: one guardian, one consented learner, and two scored drills that
 * trend from `at_risk` to `safe`.
 *
 * Phase 7 task 2. The point is not "some rows exist" — it is that the Phase 6 guardian dashboard
 * (`lib/dashboard.ts`) and the audit page (`lib/audit.ts`) both have something real to render
 * before anyone presses record: two band points, a step, an overall direction, a weakest tactic
 * with a count, a consent id, a scenario version and prompt versions. Never hand type data during
 * a recording.
 *
 * Every write goes through the `lib/db/` helpers the app itself uses, so a row this script
 * creates is a row the app could have created and is validated by the same zod schema. The two
 * exceptions are deliberate and narrow:
 *
 *   - Score rows. `lib/db/scores.ts` is read only on purpose — there is no code in the app that
 *     can put a number on a drill, and that is worth keeping true. The seed writes the row with
 *     the same client, the same key builder and the same `Score` schema, from here.
 *   - `--wipe`. Deleting is not an app capability either.
 *
 * Run it from `apps/web`:
 *
 *   AWS_PROFILE=chaukanna npm run seed:demo
 *   AWS_PROFILE=chaukanna npm run seed:demo -- --owner-sub=<your Cognito sub>
 *   AWS_PROFILE=chaukanna npm run seed:demo -- --wipe
 *
 * Idempotent: ids are derived, not random, and every write is either conditional or an overwrite
 * of the same key. Timestamps are anchored to today's UTC midnight so a re-run on the same day
 * lands on the same sort keys; `--wipe` clears the household's rows whatever day they were made.
 */

import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, keys, table } from '../src/lib/db/client';
import {
  DEFAULT_WINDOW,
  DRILL_MAX_SECONDS,
  Score,
  getLatestConsent,
  listDrills,
  putConsent,
  putDrill,
  putHousehold,
  putMember,
  putWindow,
  type Consent,
  type Drill,
  type Member,
} from '../src/lib/db';
import { isConditionFailure } from '../src/lib/db/client';
import { householdIdForGuardian } from '../src/lib/households';
import { sha256Hex } from '../src/lib/signing';
import { SCENARIO_ID } from '../src/lib/drills';

/** The sub a seeded household is owned by unless `--owner-sub` names a real one. */
const DEFAULT_OWNER_SUB = 'demo-seed-guardian';

/** Ids the agent and the scoring service stamp on real rows, so the audit table reads true. */
const SCENARIO_VERSION = 1;
const PROMPT_VERSIONS = {
  persona: 'drill.persona.v1',
  kickoff: 'drill.kickoff.v1',
  break_character: 'drill.break_character.v1',
};
const RUBRIC_VERSION = 'prd.v1';
const JUDGE_PROMPT_VERSION = 'score.judge.v2';
const DEBRIEF_PROMPT_VERSION = 'debrief.writer.v1';
const JUDGE_MODEL_ID = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
}

/** A stable id in the shape the schema requires: 20 hex characters, derived from its own name. */
function derivedId(label: string): string {
  return sha256Hex(label).slice(0, 20);
}

/** Today at 00:00 UTC, so two runs on the same day produce the same sort keys. */
function anchor(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function daysAgo(days: number, hourUtc: number): string {
  return new Date(anchor() - days * 86_400_000 + hourUtc * 3_600_000).toISOString();
}

interface Plan {
  ownerSub: string;
  householdId: string;
  memberId: string;
  consentAt: string;
  drills: { drill: Drill; score: Score }[];
}

function plan(ownerSub: string): Plan {
  const householdId = householdIdForGuardian(ownerSub);
  const memberId = derivedId(`demo-member:${householdId}`);
  const consentAt = daysAgo(28, 9);

  /**
   * Two calls, three weeks apart. The first is the one a family recognises: she stayed on, took
   * the caller for an official and read out an identifier. The second is the same scenario after
   * a debrief — she still took him for an official for a moment, then verified independently and
   * named the helpline. Bands are what the rubric in `services/scoring` would actually produce:
   * 50 − 25 − 30 − 10 = 0 (`at_risk`), and 50 − 10 + 25 + 15 = 80 (`safe`).
   */
  const first = scoredDrill({
    householdId,
    memberId,
    label: 'demo-drill-1',
    scheduledAt: daysAgo(21, 11),
    endedAt: daysAgo(21, 11.09),
    durationSeconds: 318,
    endReason: 'timeout',
    finalStage: 'S4',
    score: 0,
    band: 'at_risk',
    flags: {
      stayed_on_call: true,
      accepted_authority: true,
      shared_identifier: true,
      accepted_secrecy: false,
      agreed_to_move_money: false,
    },
    credits: { disconnected_early: false, independent_verify: false, named_helpline: false },
    redFlags: [
      { id: 'accepted_authority', stage: 'S1', seq: 6 },
      { id: 'stayed_on_call', stage: 'S2', seq: 14 },
      { id: 'shared_identifier', stage: 'S3', seq: 27 },
    ],
    turningPoint: 'The moment he said the case was confidential and you agreed to stay on the line.',
    debriefText:
      'You stayed calm and polite, which is never the problem. The call turned when he made it confidential — a real officer never does that. Next time, say you will call the number back yourself, and hang up.',
  });

  const second = scoredDrill({
    householdId,
    memberId,
    label: 'demo-drill-2',
    scheduledAt: daysAgo(7, 16),
    endedAt: daysAgo(7, 16.04),
    durationSeconds: 141,
    endReason: 'is_this_real',
    finalStage: 'S2',
    score: 80,
    band: 'safe',
    flags: {
      stayed_on_call: false,
      accepted_authority: true,
      shared_identifier: false,
      accepted_secrecy: false,
      agreed_to_move_money: false,
    },
    credits: { disconnected_early: false, independent_verify: true, named_helpline: true },
    redFlags: [{ id: 'accepted_authority', stage: 'S1', seq: 5 }],
    turningPoint: 'You asked him to wait while you called 1930 yourself, and he would not wait.',
    debriefText:
      'This is exactly it. You believed him for a few seconds, which anybody would, and then you did the one thing that ends every one of these calls: you offered to verify it yourself and named 1930.',
  });

  return { ownerSub, householdId, memberId, consentAt, drills: [first, second] };
}

function scoredDrill(spec: {
  householdId: string;
  memberId: string;
  label: string;
  scheduledAt: string;
  endedAt: string;
  durationSeconds: number;
  endReason: Drill['endReason'];
  finalStage: string;
  score: number;
  band: 'safe' | 'wobbly' | 'at_risk';
  flags: Record<string, boolean>;
  credits: Record<string, boolean>;
  redFlags: Drill['redFlags'];
  turningPoint: string;
  debriefText: string;
}): { drill: Drill; score: Score } {
  const drillId = derivedId(`${spec.label}:${spec.householdId}`);
  const drill: Drill = {
    drillId,
    memberId: spec.memberId,
    householdId: spec.householdId,
    scenarioId: SCENARIO_ID,
    scenarioVersion: SCENARIO_VERSION,
    language: 'hi-IN',
    state: 'scored',
    scheduledAt: spec.scheduledAt,
    createdAt: spec.scheduledAt,
    updatedAt: spec.endedAt,
    createdBy: 'guardian',
    maxSeconds: DRILL_MAX_SECONDS,
    dueAt: spec.scheduledAt,
    startedAt: spec.scheduledAt,
    endedAt: spec.endedAt,
    endReason: spec.endReason,
    endSource: 'seed-demo',
    finalStage: spec.finalStage,
    durationSeconds: spec.durationSeconds,
    redFlags: spec.redFlags,
    voice: 'matthew',
    promptVersions: PROMPT_VERSIONS,
  };

  const score: Score = {
    drillId,
    memberId: spec.memberId,
    householdId: spec.householdId,
    status: 'scored',
    createdAt: spec.endedAt,
    scheduledAt: spec.scheduledAt,
    language: 'hi-IN',
    score: spec.score,
    band: spec.band,
    flags: Object.fromEntries(Object.entries(spec.flags).map(([id, fired]) => [id, { fired }])),
    credits: Object.fromEntries(Object.entries(spec.credits).map(([id, fired]) => [id, { fired }])),
    turningPoint: spec.turningPoint,
    debriefText: spec.debriefText,
    rubricVersion: RUBRIC_VERSION,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    debriefPromptVersion: DEBRIEF_PROMPT_VERSION,
    judgeModelId: JUDGE_MODEL_ID,
  };

  return { drill, score };
}

async function putScore(score: Score): Promise<void> {
  const item = Score.parse(score);
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: { ...keys.score(item.drillId), entity: 'Score', ...item },
    }),
  );
}

async function seed(p: Plan): Promise<void> {
  const created = await putHousehold({
    householdId: p.householdId,
    ownerSub: p.ownerSub,
    name: 'Demo household',
    createdAt: p.consentAt,
  });
  say(created ? 'household created' : 'household already present', p.householdId);

  const member: Member = {
    memberId: p.memberId,
    householdId: p.householdId,
    displayName: 'Sunita (demo learner)',
    language: 'hi-IN',
    status: 'active',
    createdAt: p.consentAt,
    updatedAt: p.consentAt,
    acceptedAt: p.consentAt,
    consentAt: p.consentAt,
    transcriptSharing: false,
  };
  try {
    await putMember(member);
    say('learner created', p.memberId);
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    say('learner already present', p.memberId);
  }

  const consent: Consent = {
    memberId: p.memberId,
    householdId: p.householdId,
    at: p.consentAt,
    language: 'hi-IN',
    method: 'voice',
    categories: ['practice_calls', 'call_audio_7_days', 'outcome_to_family'],
  };
  const consented = await putConsent(consent);
  say(consented ? 'consent recorded' : 'consent already present', `CONSENT#${p.consentAt}`);

  /* A wide window so "ring now" works during a demo without editing anything on camera. */
  await putWindow({
    memberId: p.memberId,
    window: { ...DEFAULT_WINDOW, days: [1, 2, 3, 4, 5, 6, 7], start: '08:00', end: '22:00' },
    updatedAt: p.consentAt,
    updatedBy: 'learner',
  });
  say('drill window set', '08:00–22:00 IST, every day');

  for (const { drill, score } of p.drills) {
    try {
      await putDrill(drill);
      say('drill created', `${drill.drillId} ${drill.scheduledAt}`);
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      say('drill already present', `${drill.drillId} ${drill.scheduledAt}`);
    }
    await putScore(score);
    say('score written', `${score.drillId} ${score.band} (${score.score})`);
  }
}

/** Only ever the demo household's own rows, addressed by key. Never a scan, never a prefix sweep. */
async function wipe(p: Plan): Promise<void> {
  const drills = await listDrills(p.memberId, 50);
  for (const drill of drills) {
    await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.score(drill.drillId) }));
    await ddb().send(
      new DeleteCommand({
        TableName: table(),
        Key: keys.drill(drill.memberId, drill.scheduledAt, drill.drillId),
      }),
    );
    say('drill and score deleted', drill.drillId);
  }

  const consent = await getLatestConsent(p.memberId);
  if (consent) {
    await ddb().send(
      new DeleteCommand({ TableName: table(), Key: keys.consent(p.memberId, consent.at) }),
    );
    say('consent deleted', `CONSENT#${consent.at}`);
  }

  await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.window(p.memberId) }));
  await ddb().send(
    new DeleteCommand({ TableName: table(), Key: keys.member(p.householdId, p.memberId) }),
  );
  await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.household(p.householdId) }));
  say('window, learner and household deleted', p.householdId);
}

function say(what: string, detail: string): void {
  process.stdout.write(`  ${what.padEnd(34)} ${detail}\n`);
}

async function main(): Promise<void> {
  /* `lib/config` reads these lazily, so defaulting them here beats making every caller export them. */
  process.env.AWS_REGION ||= 'ap-south-1';
  process.env.TABLE_NAME ||= 'chaukanna';

  const ownerSub = arg('owner-sub') || DEFAULT_OWNER_SUB;
  const p = plan(ownerSub);

  process.stdout.write(
    `chaukanna demo seed\n` +
      `  table          ${table()}\n` +
      `  region         ${process.env.AWS_REGION}\n` +
      `  ownerSub       ${p.ownerSub}\n` +
      `  householdId    ${p.householdId}\n\n`,
  );

  if (arg('wipe') !== undefined) {
    await wipe(p);
    process.stdout.write('\ndemo household removed.\n');
    return;
  }

  await seed(p);

  /* Read back through the same helpers the dashboard uses, so a green run means a green page. */
  const { learnerProgress } = await import('../src/lib/dashboard');
  const { listScores } = await import('../src/lib/db');
  const back = await listDrills(p.memberId, 20);
  const scores = await listScores(back.map((d) => d.drillId));
  const progress = learnerProgress(back, scores);

  process.stdout.write(
    `\nread back:\n` +
      `  drills         ${back.length}\n` +
      `  band points    ${progress.points.map((pt) => `${pt.band}@${pt.at.slice(0, 10)}`).join(' -> ')}\n` +
      `  overall        ${progress.overall ?? 'n/a'}\n` +
      `  weakest        ${progress.weakest ? `${progress.weakest.label} (x${progress.weakest.count})` : 'n/a'}\n` +
      `  consent        ${(await getLatestConsent(p.memberId)) ? 'present' : 'MISSING'}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
