import { describe, expect, it } from 'vitest';
import { ABSENT, buildAuditRows, consentRef, promptVersions, type AuditEntry } from './audit';
import type { Consent, Drill, Member, Score } from './db';

/**
 * The audit table's cells. The property that matters most is the last one: a field the rows do
 * not carry prints as a dash, and is never filled in with something plausible.
 */

function member(name: string): Member {
  return {
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    displayName: name,
    language: 'hi-IN',
    status: 'active',
    createdAt: '2026-09-01T06:00:00.000Z',
    updatedAt: '2026-09-01T06:00:00.000Z',
    transcriptSharing: false,
  };
}

function drill(overrides: Partial<Drill> = {}): Drill {
  return {
    drillId: 'aaaaaaaabbbbbbbbcccc',
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    scenarioId: 'digital_arrest_v1',
    language: 'hi-IN',
    state: 'scored',
    scheduledAt: '2026-09-21T06:00:00.000Z',
    createdAt: '2026-09-21T05:00:00.000Z',
    updatedAt: '2026-09-21T06:05:00.000Z',
    createdBy: 'guardian',
    maxSeconds: 360,
    ...overrides,
  };
}

const consent: Consent = {
  memberId: 'abcdef0123456789abcd',
  householdId: '0123456789abcdef0123',
  at: '2026-09-01T06:00:00.000Z',
  language: 'hi-IN',
  method: 'voice',
  categories: ['practice_calls'],
};

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return { drill: drill(), member: member('Asha'), consent, ...overrides };
}

describe('buildAuditRows', () => {
  it('puts the newest drill at the top, whatever order the rows arrived in', () => {
    const rows = buildAuditRows([
      entry({ drill: drill({ drillId: 'old', scheduledAt: '2026-09-01T06:00:00.000Z' }) }),
      entry({ drill: drill({ drillId: 'new', scheduledAt: '2026-09-20T06:00:00.000Z' }) }),
    ]);
    expect(rows.map((row) => row.drillId)).toEqual(['new', 'old']);
  });

  it('names the reason and the state when a call actually happened', () => {
    const [row] = buildAuditRows([
      entry({ drill: drill({ endReason: 'safe_word', endedAt: '2026-09-21T06:03:00.000Z' }) }),
    ]);
    expect(row.ending).toBe('Safe word (Scored)');
    expect(row.scheduledBy).toBe('Guardian');
  });

  it('falls back to the state for a drill that never became a call', () => {
    const [row] = buildAuditRows([entry({ drill: drill({ state: 'cancelled' }) })]);
    expect(row.ending).toBe('Cancelled');
    expect(row.endedAt).toBe(ABSENT);
  });

  it('dashes every field the rows genuinely do not carry', () => {
    const [row] = buildAuditRows([entry({ consent: null })]);
    expect(row.consent).toBe(ABSENT);
    expect(row.promptVersions).toBe(ABSENT);
    expect(row.scenario).toBe(`digital_arrest_v1 ${ABSENT}`);
  });
});

describe('consentRef', () => {
  it('is the consent row key, because there is no other id', () => {
    expect(consentRef(consent)).toBe('CONSENT#2026-09-01T06:00:00.000Z');
  });

  it('says so when the consent has been withdrawn', () => {
    expect(consentRef({ ...consent, revokedAt: '2026-09-10T06:00:00.000Z' })).toContain('(withdrawn)');
  });
});

describe('promptVersions', () => {
  it('joins the caller side and the scoring side', () => {
    const score = {
      judgePromptVersion: 'score.judge.v1',
      debriefPromptVersion: 'debrief.v1',
      rubricVersion: 'prd.v1',
    } as Score;
    expect(promptVersions(drill({ promptVersions: { persona: 'persona.v2' } }), score)).toBe(
      'persona persona.v2, judge score.judge.v1, debrief debrief.v1, rubric prd.v1',
    );
  });
});
