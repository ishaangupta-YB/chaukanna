import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from './errors';
import type { Drill, Score } from './db';

/**
 * What the learner is told, and what their family is told.
 *
 * The first half of this file is the state machine the screen renders: still scoring, scored,
 * scored with no audio, and a pipeline that could not read the call. The second half is the
 * privacy property — that nothing built for a guardian can carry a quote — tested as a property
 * over the fullest score row rather than as one happy path, because the day it breaks it will
 * break by somebody adding a field, not by somebody changing a test.
 */

const db = vi.hoisted(() => ({ getScore: vi.fn(), listDrills: vi.fn() }));
const s3 = vi.hoisted(() => ({ presignGet: vi.fn() }));

vi.mock('./db', async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }));
vi.mock('./s3', () => s3);

const { lastDebriefableDrill, learnerDebrief, toGuardianBand } = await import('./debrief');
const { DEBRIEF_RULE_KEYS } = await import('./i18n');

function drill(overrides: Partial<Drill> = {}): Drill {
  return {
    drillId: 'aaaaaaaabbbbbbbbcccc',
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    scenarioId: 'digital_arrest_v1',
    language: 'hi-IN',
    state: 'ended',
    scheduledAt: '2026-09-21T06:00:00.000Z',
    createdAt: '2026-09-21T06:00:00.000Z',
    updatedAt: '2026-09-21T06:00:00.000Z',
    endedAt: '2026-09-21T06:04:00.000Z',
    createdBy: 'guardian',
    maxSeconds: 360,
    ...overrides,
  };
}

/** The fullest row the pipeline can write: every quote-bearing field populated. */
function score(overrides: Partial<Score> = {}): Score {
  return {
    drillId: 'aaaaaaaabbbbbbbbcccc',
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    status: 'scored',
    createdAt: '2026-09-21T06:04:30.000Z',
    scheduledAt: '2026-09-21T06:00:00.000Z',
    language: 'hi-IN',
    score: 35,
    band: 'at_risk',
    flags: {
      stayed_on_call: { fired: true, evidence: 'Ji sir, main sun raha hoon.' },
      agreed_to_move_money: { fired: true, evidence: 'Theek hai, main transfer kar deta hoon.' },
      accepted_secrecy: { fired: false, evidence: '' },
    },
    credits: {
      named_helpline: { fired: true, evidence: 'Main 1930 par call karunga.' },
      disconnected_early: { fired: false },
    },
    turningPoint: 'Aapke naam par ek case darj hua hai.',
    debriefText: 'Aapne achha kiya ki aapne 1930 ka naam liya…',
    debriefAudioKey: 'debrief/aaaaaaaabbbbbbbbcccc.mp3',
    debriefVoiceId: 'Kajal',
    rubricVersion: 'prd.v1',
    judgePromptVersion: 'score.judge.v1',
    debriefPromptVersion: 'debrief.writer.v1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  s3.presignGet.mockResolvedValue('https://bucket.example/debrief.mp3?sig=x');
});

describe('learnerDebrief', () => {
  it('waits rather than inventing anything while the pipeline is still running', async () => {
    db.getScore.mockResolvedValue(null);
    const view = await learnerDebrief(drill({ state: 'ended' }));
    expect(view.status).toBe('pending');
    expect(view.band).toBeUndefined();
    expect(view.score).toBeUndefined();
    expect(view.turningPoint).toBeUndefined();
  });

  it('gives the learner everything, including a short lived link to the audio', async () => {
    db.getScore.mockResolvedValue(score());
    const view = await learnerDebrief(drill({ state: 'scored' }));

    expect(view.status).toBe('scored');
    expect(view.band).toBe('at_risk');
    expect(view.score).toBe(35);
    expect(view.turningPoint).toBe('Aapke naam par ek case darj hua hai.');
    expect(view.audioUrl).toContain('sig=');
    expect(s3.presignGet).toHaveBeenCalledWith('debrief/aaaaaaaabbbbbbbbcccc.mp3');
  });

  it('returns only the flags and credits that actually fired, with their quotes', async () => {
    db.getScore.mockResolvedValue(score());
    const view = await learnerDebrief(drill({ state: 'scored' }));

    expect(view.flags.map((flag) => flag.id)).toEqual(['stayed_on_call', 'agreed_to_move_money']);
    expect(view.credits.map((credit) => credit.id)).toEqual(['named_helpline']);
    expect(view.flags[0].evidence).toBe('Ji sir, main sun raha hoon.');
  });

  it('keeps a real score when the voice failed: text is the debrief, sound is the extra', async () => {
    db.getScore.mockResolvedValue(score({ debriefAudioKey: undefined }));
    const view = await learnerDebrief(drill({ state: 'scored' }));

    expect(view.status).toBe('scored');
    expect(view.band).toBe('at_risk');
    expect(view.debriefText).toBeTruthy();
    expect(view.audioUrl).toBeUndefined();
    expect(s3.presignGet).not.toHaveBeenCalled();
  });

  it('still shows the text when presigning itself falls over', async () => {
    db.getScore.mockResolvedValue(score());
    s3.presignGet.mockRejectedValue(new Error('boom'));
    const view = await learnerDebrief(drill({ state: 'scored' }));

    expect(view.status).toBe('scored');
    expect(view.audioUrl).toBeUndefined();
    expect(view.debriefText).toBeTruthy();
  });

  it('never guesses a number when the pipeline could not read the call', async () => {
    db.getScore.mockResolvedValue({
      drillId: 'aaaaaaaabbbbbbbbcccc',
      memberId: 'abcdef0123456789abcd',
      householdId: '0123456789abcdef0123',
      status: 'score_failed',
      createdAt: '2026-09-21T06:04:30.000Z',
      failureReason: 'judge returned unparseable JSON twice',
    } satisfies Score);

    const view = await learnerDebrief(drill({ state: 'score_failed' }));
    expect(view.status).toBe('score_failed');
    expect(view.band).toBeUndefined();
    expect(view.score).toBeUndefined();
    expect(view.turningPoint).toBeUndefined();
    expect(view.debriefText).toBeUndefined();
    expect(view.flags).toEqual([]);
  });

  it('treats a row that claims to be scored but carries no band as a failure, not as a blank', async () => {
    db.getScore.mockResolvedValue(score({ band: undefined, score: undefined }));
    const view = await learnerDebrief(drill({ state: 'scored' }));
    expect(view.status).toBe('score_failed');
    expect(view.turningPoint).toBeUndefined();
  });

  it.each(['scheduled', 'due', 'session_pending', 'in_progress', 'cancelled', 'missed'] as const)(
    'has no debrief for a drill in state %s',
    async (state) => {
      await expect(learnerDebrief(drill({ state }))).rejects.toThrow(AppError);
      expect(db.getScore).not.toHaveBeenCalled();
    },
  );
});

describe('the three rules', () => {
  it('closes in the order debrief.writer.v1 fixes: hang up, 1930, never move money', () => {
    expect(DEBRIEF_RULE_KEYS).toEqual(['debriefRuleHangUp', 'debriefRuleCall1930', 'debriefRuleNeverPay']);
  });
});

describe('toGuardianBand', () => {
  it('carries a band and a date and nothing that was said', () => {
    const row = toGuardianBand(drill({ state: 'scored' }), score());

    expect(row).toEqual({
      drillId: 'aaaaaaaabbbbbbbbcccc',
      state: 'scored',
      band: 'at_risk',
      at: '2026-09-21T06:04:00.000Z',
    });
  });

  it('leaks no quote, no turning point and no number, whatever the row contains', () => {
    const row = toGuardianBand(drill({ state: 'scored' }), score());
    const serialised = JSON.stringify(row);

    // The property, not the shape: nothing the judge read out of the transcript may appear.
    for (const secret of [
      'Aapke naam par ek case darj hua hai.',
      'Ji sir, main sun raha hoon.',
      'Theek hai, main transfer kar deta hoon.',
      'Main 1930 par call karunga.',
      'Aapne achha kiya',
      '35',
    ]) {
      expect(serialised).not.toContain(secret);
    }
    expect(Object.keys(row).sort()).toEqual(['at', 'band', 'drillId', 'state']);
  });

  it('shows no band for a drill that has no verdict', () => {
    expect(toGuardianBand(drill({ state: 'missed' }), undefined).band).toBeUndefined();
    expect(toGuardianBand(drill({ state: 'ended' }), undefined).band).toBeUndefined();
  });

  it('shows no band for a drill whose pipeline failed, even though a row exists', () => {
    const failed = score({ status: 'score_failed', band: undefined, score: undefined });
    expect(toGuardianBand(drill({ state: 'score_failed' }), failed).band).toBeUndefined();
  });

  it('falls back to the scheduled time for a drill that never ended', () => {
    expect(toGuardianBand(drill({ state: 'cancelled', endedAt: undefined }), undefined).at).toBe(
      '2026-09-21T06:00:00.000Z',
    );
  });
});

describe('lastDebriefableDrill', () => {
  it('skips the drills that never became a call', async () => {
    db.listDrills.mockResolvedValue([
      drill({ drillId: 'bbbbbbbbccccddddeeee', state: 'cancelled' }),
      drill({ drillId: 'ccccddddeeeeffff0000', state: 'missed' }),
      drill({ drillId: 'ddddeeeeffff00001111', state: 'scored' }),
    ]);
    const found = await lastDebriefableDrill('abcdef0123456789abcd');
    expect(found?.drillId).toBe('ddddeeeeffff00001111');
  });

  it('is null for a learner who has never taken a call', async () => {
    db.listDrills.mockResolvedValue([drill({ state: 'scheduled' })]);
    expect(await lastDebriefableDrill('abcdef0123456789abcd')).toBeNull();
  });
});
