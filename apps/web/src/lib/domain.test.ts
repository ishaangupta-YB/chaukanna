import { describe, expect, it } from 'vitest';
import { consentAudioKey, parseConsentAudioKey } from './consent';
import { DEFAULT_WINDOW, DrillWindow, Household } from './db/models';
import { householdIdForGuardian } from './households';
import { t, TYPED_YES, windowSummary } from './i18n';

describe('DrillWindow', () => {
  it('accepts the PRD default, weekdays 11:00 to 18:00 IST', () => {
    expect(DrillWindow.safeParse(DEFAULT_WINDOW).success).toBe(true);
    expect(DEFAULT_WINDOW).toEqual({ days: [1, 2, 3, 4, 5], start: '11:00', end: '18:00', tz: 'Asia/Kolkata' });
  });

  it.each([
    ['no days', { days: [] }],
    ['duplicate days', { days: [1, 1] }],
    ['day out of range', { days: [0] }],
    ['end before start', { start: '18:00', end: '11:00' }],
    ['shorter than an hour', { start: '11:00', end: '11:30' }],
    ['bare local time without the IST zone', { tz: 'UTC' }],
    ['malformed time', { start: '9:00' }],
    ['impossible time', { end: '24:00' }],
  ])('rejects %s', (_name, override) => {
    expect(DrillWindow.safeParse({ ...DEFAULT_WINDOW, ...override }).success).toBe(false);
  });
});

describe('household ids', () => {
  it('are deterministic per guardian, so a double tap cannot create two households', () => {
    expect(householdIdForGuardian('sub-1')).toBe(householdIdForGuardian('sub-1'));
    expect(householdIdForGuardian('sub-1')).not.toBe(householdIdForGuardian('sub-2'));
  });

  it('match the stored id format', () => {
    const parsed = Household.safeParse({
      householdId: householdIdForGuardian('sub-1'),
      ownerSub: 'sub-1',
      name: 'Home',
      createdAt: new Date().toISOString(),
    });
    expect(parsed.success).toBe(true);
  });
});

describe('consent audio keys', () => {
  const at = '2026-09-20T10:15:30.123Z';

  it('round trip for the owning member', () => {
    const key = consentAudioKey('abcd1234', at, 'audio/webm');
    expect(key).toBe(`consent/abcd1234/${at}.webm`);
    expect(parseConsentAudioKey('abcd1234', key)).toEqual({ at });
  });

  it.each([
    ['another member', `consent/ffff0000/${at}.webm`],
    ['another prefix', `drill/abcd1234/${at}.webm`],
    ['traversal', `consent/abcd1234/../ffff0000/${at}.webm`],
    ['unknown extension', `consent/abcd1234/${at}.exe`],
    ['no timestamp', 'consent/abcd1234/recording.webm'],
  ])('reject %s', (_name, key) => {
    expect(parseConsentAudioKey('abcd1234', key)).toBeNull();
  });
});

describe('i18n', () => {
  it('interpolates variables and leaves unknown placeholders', () => {
    expect(t('en', 'consentGreeting', { name: 'Kamla' })).toBe('Hello Kamla.');
    expect(t('hi', 'consentGreeting', { name: 'कमला' })).toBe('कमला जी, नमस्ते।');
    expect(t('en', 'consentGreeting')).toBe('Hello {name}.');
  });

  it('summarises a window in both languages', () => {
    expect(windowSummary('en', [5, 1], '11:00', '18:00')).toBe('Mon, Fri, 11:00 to 18:00');
    expect(windowSummary('hi', [1], '11:00', '18:00')).toBe('सोम, 11:00 से 18:00 तक');
  });

  it('accepts both Hindi spellings of yes for the typed fallback', () => {
    for (const word of ['हाँ', 'हां', 'yes', 'haan']) expect(TYPED_YES.has(word)).toBe(true);
    expect(TYPED_YES.has('no')).toBe(false);
  });
});
