/**
 * "3 minutes ago", in the reader's own language.
 *
 * IT LIVES HERE BECAUSE TWO SCREENS PRINT IT. The history page prints an
 * instant on every recorded search, and the home screen prints one on the last
 * few. Written twice, the two would drift into two ways of saying the same age.
 *
 * The formatting itself is `Intl`'s, not this app's: a relative time is
 * language data, and no catalogue of ours should carry "ago" in nine forms.
 */

/**
 * The units a relative timestamp may be expressed in, coarsest last.
 *
 * `amount` is how many of this unit make up the next one, so the loop below
 * divides its way up the scale and stops at the first unit the age fits inside.
 */
const TIME_DIVISIONS = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
] as const satisfies readonly { amount: number; unit: Intl.RelativeTimeFormatUnit }[];

/**
 * @param atMs - the instant being described.
 * @param nowMs - the instant it is measured against, passed in rather than read
 *   here so every row on one screen is measured against the same moment.
 * @param language - the reader's UI language.
 */
export function formatRelativeTime(atMs: number, nowMs: number, language: string): string {
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  let duration = (atMs - nowMs) / 1000;
  for (const division of TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) return formatter.format(Math.round(duration), division.unit);
    duration /= division.amount;
  }
  return formatter.format(Math.round(duration), 'year');
}
