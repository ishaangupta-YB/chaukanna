import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 6 task 8, as a test rather than as a memory of having looked once.
 *
 * The learner is the person this product exists for, and they are likely to be sixty or seventy,
 * holding a phone at arm's length, possibly for the first time in a language they read slowly.
 * The thresholds — 20px text, 48px targets — come from that, not from a lint preset. They are
 * cheap to meet and silently easy to lose: one `text-sm` copied from a guardian screen is enough,
 * and nobody notices on a laptop.
 *
 * So the check is mechanical and it runs with everything else. It reads the Tailwind classes the
 * learner-facing files actually ship, which is where the sizes live in this app.
 */

const ROOT = join(import.meta.dirname, '../..');

/** Every file that renders on a screen the learner sees. */
const LEARNER_SOURCES = [
  ...readdirSync(join(ROOT, 'components/learner'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join('components/learner', f)),
  'components/WindowPicker.tsx',
  'app/me/page.tsx',
  'app/me/window/page.tsx',
  'app/me/consent/page.tsx',
  'app/drill/[id]/page.tsx',
  'app/drill/[id]/debrief/page.tsx',
  'app/join/[token]/page.tsx',
];

/** Tailwind's scale, in px. Anything below `text-xl` is too small to read at arm's length. */
const TEXT_PX: Record<string, number> = {
  'text-xs': 12,
  'text-sm': 14,
  'text-base': 16,
  'text-lg': 18,
  'text-xl': 20,
  'text-2xl': 24,
  'text-3xl': 30,
  'text-4xl': 36,
};

const MIN_TEXT_PX = 20;
const MIN_TARGET_PX = 48;

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

describe('learner screens, at arm’s length', () => {
  it.each(LEARNER_SOURCES)('%s sets no text smaller than 20px', (file) => {
    const source = read(file);
    const tooSmall = Object.entries(TEXT_PX)
      .filter(([, px]) => px < MIN_TEXT_PX)
      // Word boundaries, so `text-sm` does not match inside a longer class name.
      .filter(([name]) => new RegExp(`(^|[\\s"'\`])${name}([\\s"'\`]|$)`).test(source))
      .map(([name]) => name);

    expect(tooSmall, `${file} uses ${tooSmall.join(', ')}; the learner minimum is text-xl (20px)`).toEqual([]);
  });

  it.each(LEARNER_SOURCES)('%s gives every sized control a 48px touch target', (file) => {
    const source = read(file);
    // `min-h-N` is `N * 4` px in Tailwind's spacing scale. `min-h-11` (44px) is the guardian
    // screens' size and is deliberately not enough here.
    const tooShort = [...source.matchAll(/min-h-(\d+)\b/g)]
      .map((match) => Number(match[1]) * 4)
      .filter((px) => px < MIN_TARGET_PX);

    expect(tooShort, `${file} has a control ${tooShort.join('px, ')}px tall; the minimum is 48px`).toEqual([]);
  });

  it('keeps the shell body text at 20px, which every screen inherits', () => {
    // The floor for anything that does not set a size of its own.
    expect(read('components/learner/LearnerShell.tsx')).toMatch(/className="[^"]*\btext-xl\b/);
  });

  /**
   * The three screens allowed a timer, and why. Everything else must be untimed: a learner who
   * puts the phone down to fetch their glasses has to find the screen exactly as they left it.
   */
  const TIMER_ALLOWED: Record<string, string> = {
    'components/learner/DrillCall.tsx': 'the call itself, which has a hard cap by design',
    'components/learner/ConsentFlow.tsx': 'a fixed-length voice recording, with an untimed typed fallback',
    'components/learner/Debrief.tsx': 'polling for a score that is still being computed',
  };

  it('puts no learner screen on a clock except the three that have a reason to be', () => {
    const timed = LEARNER_SOURCES.filter((file) => /secondsLeft|setTimeout\(|setInterval\(/.test(read(file)));
    expect(timed.sort()).toEqual(Object.keys(TIMER_ALLOWED).sort());
  });

  it('never lets a timer outside the call take the screen away from the learner', () => {
    // A countdown that only reports progress is not time pressure. A countdown that navigates,
    // resets a form or discards an answer is, and neither of these two may do that.
    for (const file of ['components/learner/ConsentFlow.tsx', 'components/learner/Debrief.tsx']) {
      const source = read(file);
      const timerBodies = source.split(/setInterval\(|setTimeout\(/).slice(1);
      for (const body of timerBodies) {
        const scope = body.slice(0, 400);
        expect(scope, `a timer in ${file} navigates the learner away`).not.toMatch(/router\.(push|replace)/);
      }
    }
  });
});
