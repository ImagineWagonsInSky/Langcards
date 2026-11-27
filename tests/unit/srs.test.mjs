import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, newState, isDue, isLearned, isMature, previewInterval, AGAIN, HARD, GOOD, EASY } from '../../assets/js/srs.js';

const T = 20000;

test('good answers grow the interval 1 -> 3 -> ~8 days', () => {
  let s = schedule(null, GOOD, T);
  assert.equal(s.i, 1);
  assert.equal(s.d, T + 1);
  s = schedule(s, GOOD, T + 1);
  assert.equal(s.i, 3);
  s = schedule(s, GOOD, T + 4);
  assert.equal(s.i, 8); // round(3 * 2.5)
  assert.equal(s.r, 3);
});

test('again resets, counts a lapse and lowers ease', () => {
  let s = schedule(null, GOOD, T);
  s = schedule(s, GOOD, T + 1);
  const a = schedule(s, AGAIN, T + 4);
  assert.equal(a.i, 0);
  assert.equal(a.d, T + 4);
  assert.equal(a.l, 1);
  assert.equal(a.r, 0);
  assert.equal(a.e, 230);
  // relearned in the same session -> tomorrow
  assert.equal(schedule(a, GOOD, T + 4).i, 1);
});

test('again on a brand-new card is not a lapse', () => {
  assert.equal(schedule(null, AGAIN, T).l, 0);
});

test('hard and easy', () => {
  assert.equal(schedule(null, HARD, T).i, 1);
  assert.equal(schedule(null, EASY, T).i, 4);
  const s = { ...newState(), i: 10, r: 3, e: 250 };
  assert.ok(schedule(s, HARD, T).i >= 11);
  assert.ok(schedule(s, EASY, T).i > schedule(s, GOOD, T).i);
  assert.equal(schedule(s, HARD, T).e, 235);
});

test('ease never drops below 1.3 and intervals are capped', () => {
  let s = newState();
  for (let k = 0; k < 20; k++) s = schedule(s, AGAIN, T);
  assert.equal(s.e, 130);
  const big = { ...newState(), i: 3000, r: 9, e: 300 };
  assert.equal(schedule(big, EASY, T).i, 3650);
});

test('schedule does not mutate its input', () => {
  const s = Object.freeze({ ...newState(), i: 3, r: 2 });
  assert.doesNotThrow(() => schedule(s, GOOD, T));
});

test('due / learned / mature / suspended', () => {
  const s = schedule(null, GOOD, T);
  assert.equal(isDue(s, T), false);
  assert.equal(isDue(s, T + 1), true);
  assert.equal(isDue({ ...s, s: 1 }, T + 5), false);
  assert.equal(isLearned(s), true);
  assert.equal(isMature(s), false);
  assert.equal(isMature({ ...s, i: 30 }), true);
  assert.throws(() => schedule(null, 7, T));
});

test('interval preview labels', () => {
  assert.equal(previewInterval(null, AGAIN, T), '<1 d');
  assert.equal(previewInterval(null, GOOD, T), '1 d');
  assert.equal(previewInterval({ ...newState(), i: 40, r: 5, e: 250 }, GOOD, T), '3 mo');
});
