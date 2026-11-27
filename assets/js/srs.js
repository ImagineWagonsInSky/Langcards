// Spaced repetition (a compact SM-2 variant, similar to Anki).
// A card's state: { d: due day, i: interval (days), e: ease x100, r: successful reps in a row,
//                   l: lapses, t: last review day, s: 1 if suspended }
// Grades: 0 = again, 1 = hard, 2 = good, 3 = easy.

export const AGAIN = 0, HARD = 1, GOOD = 2, EASY = 3;
const MIN_EASE = 130, START_EASE = 250, MAX_IVL = 3650;

export function newState() {
  return { d: 0, i: 0, e: START_EASE, r: 0, l: 0, t: 0 };
}

/** Returns a NEW state object; does not mutate `prev`. */
export function schedule(prev, grade, today) {
  const s = { ...(prev || newState()) };
  const ease = s.e / 100;
  let ivl;
  if (grade === AGAIN) {
    if (s.r > 0) s.l += 1;
    s.r = 0;
    s.e = Math.max(MIN_EASE, s.e - 20);
    ivl = 0; // due again today (re-asked in the session)
  } else if (grade === HARD) {
    ivl = s.r === 0 ? 1 : Math.max(s.i + 1, Math.round(s.i * 1.2));
    s.e = Math.max(MIN_EASE, s.e - 15);
    s.r += 1;
  } else if (grade === GOOD) {
    ivl = s.r === 0 ? 1 : s.r === 1 ? 3 : Math.max(s.i + 1, Math.round(s.i * ease));
    s.r += 1;
  } else if (grade === EASY) {
    ivl = s.r === 0 ? 4 : Math.max(s.i + 2, Math.round(s.i * ease * 1.3));
    s.e = s.e + 15;
    s.r += 1;
  } else {
    throw new Error(`bad grade ${grade}`);
  }
  s.i = Math.min(MAX_IVL, ivl);
  s.d = today + s.i;
  s.t = today;
  return s;
}

export function isDue(s, today) {
  return !!s && !s.s && s.d <= today;
}

/** Card has been answered correctly at least once and is scheduled for a later day. */
export function isLearned(s) {
  return !!s && s.i >= 1;
}

export function isMature(s) {
  return !!s && s.i >= 21;
}

/** Human description of the next interval for a grade, e.g. "3 d". */
export function previewInterval(prev, grade, today) {
  const n = schedule(prev, grade, today).i;
  if (n === 0) return '<1 d';
  if (n < 30) return `${n} d`;
  if (n < 365) return `${Math.round(n / 30)} mo`;
  return `${(n / 365).toFixed(1)} y`;
}
