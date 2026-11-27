import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, loose, numberWord, checkAnswer, tileTokens, speechScore, answerVariants, splitArticle, levenshtein, lcsFlags } from '../../assets/js/text.js';

test('normalize removes punctuation and case, keeps accents and inner apostrophes', () => {
  assert.equal(normalize('¿Dónde está?'), 'dónde está');
  assert.equal(normalize("L’acqua è fredda, vero?"), "l'acqua è fredda vero");
  assert.equal(normalize("Un po' di pane."), "un po' di pane");
  assert.equal(normalize('  "Ciao"  '), 'ciao');
  assert.equal(normalize('«Sì», disse.'), 'sì disse');
});

test('numbers as words (Italian)', () => {
  const cases = { 0: 'zero', 1: 'uno', 13: 'tredici', 17: 'diciassette', 20: 'venti', 21: 'ventuno', 23: 'ventitré', 28: 'ventotto', 30: 'trenta', 33: 'trentatré', 41: 'quarantuno', 99: 'novantanove', 100: 'cento' };
  for (const [n, w] of Object.entries(cases)) assert.equal(numberWord(Number(n), 'it'), w, n);
});

test('numbers as words (Spanish)', () => {
  const cases = { 0: 'cero', 15: 'quince', 16: 'dieciséis', 21: 'veintiuno', 22: 'veintidós', 29: 'veintinueve', 30: 'treinta', 31: 'treinta y uno', 47: 'cuarenta y siete', 100: 'cien' };
  for (const [n, w] of Object.entries(cases)) assert.equal(numberWord(Number(n), 'es'), w, n);
  assert.equal(numberWord(101, 'es'), null);
});

test('loose form ignores accents, apostrophes, digits vs words', () => {
  assert.equal(loose('Perché?', 'it'), 'perche');
  assert.equal(loose('Ho 3 figli.', 'it'), loose('Ho tre figli', 'it'));
  assert.equal(loose('Costa 30 €', 'it'), 'costa trenta euro');
});

test('levenshtein and lcs', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.deepEqual(lcsFlags(['a', 'x', 'c'], ['a', 'b', 'c']), [true, false, true]);
});

test('checkAnswer: exact, case and punctuation insensitive', () => {
  assert.equal(checkAnswer('sono stanco', ['Sono stanco.'], 'it').status, 'correct');
  assert.equal(checkAnswer('Sono stanco!!', ['Sono stanco.'], 'it').status, 'correct');
});

test('checkAnswer: optional subject pronoun both ways', () => {
  assert.equal(checkAnswer('Io sono stanco', ['Sono stanco.'], 'it').status, 'correct');
  assert.equal(checkAnswer('Sono stanco', ['Io sono stanco.'], 'it').status, 'correct');
  assert.equal(checkAnswer('Tengo hambre', ['Yo tengo hambre.'], 'es').status, 'correct');
});

test('checkAnswer: any accepted translation counts', () => {
  assert.equal(checkAnswer('Come stai', ['Come va?', 'Come stai?'], 'it').status, 'correct');
});

test('checkAnswer: missing accents are flagged but accepted', () => {
  const r = checkAnswer('perche', ['Perché?'], 'it');
  assert.equal(r.status, 'accent');
  assert.equal(checkAnswer('Lui e qui', ['Lui è qui.'], 'it').status, 'accent');
});

test('checkAnswer: one-letter slip in a long word is a typo, short words must be exact', () => {
  assert.equal(checkAnswer('Abbiamo visitatto Parigi', ['Abbiamo visitato Parigi.'], 'it').status, 'typo');
  assert.equal(checkAnswer('carro', ['caro'], 'it', { word: true }).status, 'wrong');
  assert.equal(checkAnswer('Il cane mangia', ['Il gatto mangia.'], 'it').status, 'wrong');
});

test('checkAnswer: wrong answers report the closest correction', () => {
  const r = checkAnswer('Buongiorno', ['Ciao!', 'Buonasera!'], 'it');
  assert.equal(r.status, 'wrong');
  assert.equal(r.expected, 'Buonasera!');
  assert.equal(checkAnswer('   ', ['Ciao'], 'it').status, 'empty');
});

test('checkAnswer: word cards accept with or without the article, flag a wrong article', () => {
  assert.equal(checkAnswer('cane', ['il cane'], 'it', { word: true }).status, 'correct');
  assert.equal(checkAnswer('il cane', ['il cane'], 'it', { word: true }).status, 'correct');
  assert.equal(checkAnswer("l'acqua", ["l'acqua"], 'it', { word: true }).status, 'correct');
  assert.equal(checkAnswer('acqua', ["l'acqua"], 'it', { word: true }).status, 'correct');
  const r = checkAnswer('la cane', ['il cane'], 'it', { word: true });
  assert.equal(r.status, 'article');
  assert.match(r.note, /il/);
  assert.equal(checkAnswer('gatto', ['il cane'], 'it', { word: true }).status, 'wrong');
  assert.equal(checkAnswer('perro', ['el perro'], 'es', { word: true }).status, 'correct');
});

test('splitArticle', () => {
  assert.deepEqual(splitArticle('lo zio', 'it'), ['lo', 'zio']);
  assert.deepEqual(splitArticle("un'amica", 'it'), ["un'", 'amica']);
  assert.deepEqual(splitArticle('gli occhi', 'it'), ['gli', 'occhi']);
  assert.deepEqual(splitArticle('uno', 'it'), [null, 'uno']);
  assert.deepEqual(splitArticle('i genitori', 'it'), ['i', 'genitori']);
});

test('tileTokens keeps apostrophes and drops punctuation', () => {
  assert.deepEqual(tileTokens("L'acqua è fredda, vero?"), ["L'acqua", 'è', 'fredda', 'vero']);
  assert.deepEqual(tileTokens("Un po' di pane."), ['Un', "po'", 'di', 'pane']);
  assert.deepEqual(tileTokens('¿Qué hora es?'), ['Qué', 'hora', 'es']);
  assert.deepEqual(tileTokens('Costa 30 € — davvero!'), ['Costa', '30', 'davvero']);
});

test('speechScore: perfect, numbers, partial, wrong', () => {
  assert.equal(speechScore(['ho fame'], ['Ho fame.'], 'it').score, 1);
  assert.equal(speechScore(['ho 3 figli'], ['Ho tre figli.'], 'it').score, 1);
  const partial = speechScore(['ho fame'], ['Ho molta fame.'], 'it');
  assert.ok(partial.score > 0.5 && partial.score < 0.95, String(partial.score));
  assert.deepEqual(partial.words.map((w) => w.ok), [true, false, true]);
  assert.ok(speechScore(['buonasera'], ['Ho fame.'], 'it').score < 0.4);
  // picks the best of several recogniser alternatives
  assert.equal(speechScore(['o fame', 'ho fame'], ['Ho fame.'], 'it').score, 1);
});

test('answerVariants adds article-less and pronoun-less forms', () => {
  assert.deepEqual(answerVariants(['il cane'], 'it', true).map((v) => v.say), ['il cane', 'cane']);
  const s = answerVariants(['Io sono stanco.'], 'it', false);
  assert.ok(s.some((v) => v.say === 'sono stanco' && v.orig === 'Io sono stanco.'));
  assert.equal(speechScore(['cane'], answerVariants(['il cane'], 'it', true).map((v) => v.say), 'it').score, 1);
});
