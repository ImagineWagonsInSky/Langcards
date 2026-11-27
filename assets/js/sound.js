// Tiny synthesized feedback sounds (no audio files needed).
let ctx = null;

function tone(freq, start, dur, gain = 0.12, type = 'sine') {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + start);
  o.stop(ctx.currentTime + start + dur + 0.02);
}

export function play(kind, enabled = true) {
  if (!enabled) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
    if (kind === 'good') {
      tone(660, 0, 0.12);
      tone(880, 0.1, 0.18);
    } else if (kind === 'bad') {
      tone(220, 0, 0.22, 0.1, 'triangle');
    } else if (kind === 'done') {
      tone(523, 0, 0.12);
      tone(659, 0.12, 0.12);
      tone(784, 0.24, 0.25);
    }
  } catch { /* sound is optional */ }
}
