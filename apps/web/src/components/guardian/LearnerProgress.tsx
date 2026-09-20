import { istDateTime, type LearnerProgress as Progress } from '@/lib/dashboard';
import { BAND } from './BandChip';

/**
 * Which way a learner is going, and what keeps catching them.
 *
 * A list with an arrow between each pair rather than a chart: three or four points do not need a
 * plotting library, and a list is readable by a screen reader, on a phone, and on a projector at
 * the back of a room. The arrows are decorative — the direction is also in the text of each step,
 * so nothing here depends on seeing a glyph or a colour.
 *
 * This component renders what it is handed. It does no fetching and takes no view on who may look
 * at it; the page decides that before it gets here.
 */

const STEP: Record<Progress['steps'][number]['direction'], { arrow: string; word: string; tone: string }> = {
  better: { arrow: '↑', word: 'better than last time', tone: 'text-emerald-800' },
  worse: { arrow: '↓', word: 'harder than last time', tone: 'text-orange-800' },
  same: { arrow: '→', word: 'same as last time', tone: 'text-stone-700' },
};

const OVERALL: Record<Progress['steps'][number]['direction'], string> = {
  better: 'Going in the right direction.',
  worse: 'Going the other way at the moment.',
  same: 'Holding steady.',
};

export function LearnerProgress({ progress, name }: { progress: Progress; name: string }) {
  const { points, steps, overall, weakest } = progress;

  if (points.length === 0) {
    return <p className="text-base text-stone-600">No practice calls have been scored yet, so there is no trend to show.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1">
        {points.map((point, i) => (
          <li key={point.drillId} className="flex flex-col gap-1">
            {i > 0 && (
              <span className={`text-base font-semibold ${STEP[steps[i - 1].direction].tone}`}>
                <span aria-hidden="true">{STEP[steps[i - 1].direction].arrow}</span> {STEP[steps[i - 1].direction].word}
              </span>
            )}
            <span className="flex flex-wrap items-center gap-2 text-base">
              <span className={`rounded-full px-3 py-1 text-sm font-semibold ${BAND[point.band].tone}`}>
                {BAND[point.band].label}
              </span>
              <span>{istDateTime(point.at)} IST</span>
            </span>
          </li>
        ))}
      </ol>

      {overall && <p className="text-base font-semibold">{OVERALL[overall]}</p>}
      {points.length === 1 && (
        <p className="text-base text-stone-600">One practice call so far. A second one is what makes a trend.</p>
      )}

      {weakest && (
        <p className="text-base">
          <span className="text-stone-600">What catches {name} most often: </span>
          <span className="font-semibold">{weakest.label}</span>
          <span className="text-stone-600">
            {' '}
            — {weakest.count} {weakest.count === 1 ? 'call' : 'calls'} out of {points.length}.
          </span>
        </p>
      )}
    </div>
  );
}
