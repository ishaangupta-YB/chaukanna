import { describe, expect, it } from 'vitest';
import { DrillState, Score } from './models';

/**
 * The shape the scoring pipeline writes, read from the web app's side.
 *
 * The app never writes one of these, so the interesting cases are all about reading: a row that
 * failed and therefore has no number, a row from a pipeline that learned a new field, and a row
 * that is missing something the screen needed. The rule is that a sloppy write costs a line on
 * the debrief, never the whole debrief.
 */

const scored = {
  pk: 'DRILL#aaaaaaaabbbbbbbbcccc',
  sk: 'SCORE',
  entity: 'Score',
  drillId: 'aaaaaaaabbbbbbbbcccc',
  memberId: 'abcdef0123456789abcd',
  householdId: '0123456789abcdef0123',
  scheduledAt: '2026-09-21T06:00:00.000Z',
  language: 'hi-IN',
  status: 'scored',
  score: 35,
  band: 'at_risk',
  flags: { agreed_to_move_money: { fired: true, evidence: 'Theek hai.' } },
  credits: { named_helpline: { fired: false } },
  turningPoint: 'Aapke naam par ek case darj hua hai.',
  debriefText: 'Aapne achha kiya…',
  debriefAudioKey: 'debrief/aaaaaaaabbbbbbbbcccc.mp3',
  debriefVoiceId: 'Kajal',
  rubricVersion: 'prd.v1',
  judgePromptVersion: 'score.judge.v1',
  debriefPromptVersion: 'debrief.writer.v1',
  judgeModelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  guardrailId: 'gr-123',
  guardrailVersion: 'DRAFT',
  createdAt: '2026-09-21T06:04:30.000Z',
};

describe('Score', () => {
  it('parses the row the pipeline writes for a scored drill', () => {
    const parsed = Score.parse(scored);
    expect(parsed.band).toBe('at_risk');
    expect(parsed.score).toBe(35);
    expect(parsed.flags?.agreed_to_move_money).toEqual({ fired: true, evidence: 'Theek hai.' });
    expect(parsed.credits?.named_helpline.fired).toBe(false);
  });

  it('parses a failed row, which has neither a score nor a band', () => {
    const parsed = Score.parse({
      drillId: 'aaaaaaaabbbbbbbbcccc',
      memberId: 'abcdef0123456789abcd',
      householdId: '0123456789abcdef0123',
      status: 'score_failed',
      failureReason: 'guardrail call failed',
      createdAt: '2026-09-21T06:04:30.000Z',
    });
    expect(parsed.score).toBeUndefined();
    expect(parsed.band).toBeUndefined();
    expect(parsed.failureReason).toBe('guardrail call failed');
  });

  it('survives a pipeline that forgot the optional context fields', () => {
    const { scheduledAt, language, rubricVersion, ...thin } = scored;
    expect(() => Score.parse(thin)).not.toThrow();
    expect(scheduledAt && language && rubricVersion).toBeTruthy();
  });

  /**
   * `services/scoring/scoring_service/finish.py` builds the item by hand on boto3 with no
   * pydantic, and writes `{"S": ""}` for anything it had no value for. These are the rows it
   * really produces, not the ones the contract describes.
   */
  it('reads the pipeline’s empty strings as absent rather than throwing on them', () => {
    const parsed = Score.parse({
      ...scored,
      status: 'score_failed',
      score: undefined,
      band: undefined,
      scheduledAt: '',
      language: '',
      turningPoint: '',
      debriefText: '',
      debriefPromptVersion: '',
      guardrailVersion: '',
    });

    expect(parsed.scheduledAt).toBeUndefined();
    expect(parsed.language).toBeUndefined();
    expect(parsed.turningPoint).toBeUndefined();
    expect(parsed.debriefText).toBeUndefined();
    expect(parsed.guardrailVersion).toBeUndefined();
  });

  it('drops the redacted transcript key, so it cannot leave the table', () => {
    // `finish.py` puts `redactedKey` on the row. Nothing in the app is allowed to hold it: a
    // guardian may not read a transcript, and the surest way is for the key never to be parsed.
    const parsed = Score.parse({ ...scored, redactedKey: 'drill/redacted/aaaaaaaabbbbbbbbcccc.json' });
    expect(JSON.stringify(parsed)).not.toContain('redacted');
  });

  it('refuses a status that is not one of the two the contract allows', () => {
    expect(Score.safeParse({ ...scored, status: 'pending' }).success).toBe(false);
  });

  it('refuses a band the rubric does not define', () => {
    expect(Score.safeParse({ ...scored, band: 'excellent' }).success).toBe(false);
  });

  it('refuses a score outside 0..100, which the rubric clamps to', () => {
    expect(Score.safeParse({ ...scored, score: 101 }).success).toBe(false);
    expect(Score.safeParse({ ...scored, score: -1 }).success).toBe(false);
  });
});

describe('DrillState', () => {
  it('accepts the two states Phase 5 adds', () => {
    expect(DrillState.parse('scored')).toBe('scored');
    expect(DrillState.parse('score_failed')).toBe('score_failed');
  });

  it('still accepts every state the earlier phases wrote', () => {
    for (const state of ['scheduled', 'due', 'session_pending', 'in_progress', 'ended', 'cancelled', 'missed']) {
      expect(DrillState.parse(state)).toBe(state);
    }
  });

  it('is exactly nine states, so a new one cannot arrive unnoticed', () => {
    expect(DrillState.options).toHaveLength(9);
  });
});
