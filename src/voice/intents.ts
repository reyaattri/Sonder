/**
 * Understanding short spoken commands for the voice menu. Deliberately
 * simple and predictable: whole-word keyword matching with synonyms, so
 * "I want to run on the track" and "run" both mean RUN, and anything
 * ambiguous is reported as not understood (the menu then explains the taps).
 */

export type Intent =
  | 'walk'
  | 'run'
  | 'chest'
  | 'waist'
  | 'hand'
  | 'table'
  | 'lanes'
  | 'line'
  | 'edge'
  | 'simulator'
  | 'start'
  | 'back'
  | 'help'
  | 'settings'
  | 'sound'
  | 'louder'
  | 'quieter'
  | 'calmer'
  | 'detailed'
  | 'surroundOn'
  | 'surroundOff'
  | 'caneOn'
  | 'caneOff'
  | 'echoOn'
  | 'echoOff'
  | 'done'
  | 'yes'
  | 'no'
  | 'live'
  | 'scan'
  | 'describe'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'stats';

const WORDS: [Intent, string[]][] = [
  // Multi-word phrases first (they win over single words).
  ['describe', ["what's around me", 'whats around me', 'what is around me', 'what is around', "what's around", 'describe', 'what do you see', 'what can you see', "what's ahead", 'what is ahead', 'whats ahead']],
  ['scan', ['scan around me', 'scan again', 'scan', 'look around', 'rescan']],
  ['live', ['live view', 'live mode', 'live', 'real world', 'use the camera', 'camera']],
  ['stats', ['my stats', 'stats', 'statistics', 'my pace', 'pace', 'how far', 'distance', 'how am i doing']],
  ['resume', ['resume', 'continue', 'carry on', 'unpause', 'keep going']],
  ['pause', ['pause', 'hold on', 'wait']],
  ['stop', ['stop', 'end', 'finish', 'quit', 'stop guidance']],
  ['surroundOff', ['surround off', 'turn off surround', 'no surround', 'stop surround']],
  ['surroundOn', ['surround on', 'turn on surround', 'surround sound', 'surround', '8d', 'eight d']],
  ['caneOff', ['cane off', 'turn off cane', 'no cane', 'stop cane']],
  ['caneOn', ['cane on', 'turn on cane', 'white cane', 'virtual cane', 'cane']],
  ['echoOff', ['echo off', 'echolocation off', 'turn off echo', 'stop echo', 'no echo']],
  ['echoOn', ['echo on', 'echolocation on', 'echolocation', 'echo', 'clicks']],
  ['sound', ['sound check', 'test sound', 'check sound', 'headphone check', 'headphones']],
  ['line', ['guide line', 'yellow line', 'blue line', 'racing line', 'line']],
  ['edge', ['kerb', 'curb', 'edge', 'road side', 'roadside', 'side of the road']],
  ['simulator', ['simulator', 'simulation', 'practice', 'demo', 'try it']],
  ['lanes', ['lanes', 'lane', 'track lines', 'athletics track', 'stadium']],
  ['run', ['run', 'running', 'race', 'marathon', 'sprint', 'track', 'jog', 'jogging']],
  ['walk', ['walk', 'walking', 'stroll', 'street', 'outside', 'explore']],
  ['chest', ['chest', 'lanyard', 'neck', 'strap']],
  ['waist', ['waist', 'belt', 'hip', 'pocket']],
  ['hand', ['hand', 'holding', 'hold it', 'in my hand']],
  ['table', ['table', 'desk', 'laptop', 'on a table']],
  ['louder', ['louder', 'volume up', 'turn it up', 'more volume']],
  ['quieter', ['quieter', 'softer', 'volume down', 'turn it down', 'less volume']],
  ['calmer', ['calmer', 'calm', 'fewer', 'less beeping', 'too many beeps', 'less']],
  ['detailed', ['more detail', 'detailed', 'detail', 'more']],
  ['settings', ['settings', 'options', 'preferences', 'set up', 'setup']],
  ['start', ['start', 'go', 'begin', 'lets go', "let's go", 'ready', 'start now']],
  ['back', ['back', 'go back', 'previous', 'return']],
  ['help', ['help', 'repeat', 'again', 'say again', 'what are my options', 'options please']],
  ['done', ['done', 'finished', 'exit', 'close', "that's all", 'thats all']],
  ['yes', ['i understand', 'understood', 'agree', 'i agree', 'yes', 'yeah', 'yep', 'correct', 'i heard it', 'ok', 'okay']],
  ['no', ['no', 'nope', "didn't", 'did not', 'not really']],
];

/**
 * What speech recognisers commonly hear instead of our words (accents, noise,
 * Bluetooth call-quality microphones). Applied only as a second pass.
 */
const SOUNDS_LIKE: Record<string, string> = {
  woke: 'walk', wok: 'walk', wark: 'walk', wolk: 'walk', walks: 'walk', walked: 'walk',
  ron: 'run', rum: 'run', ran: 'run', runs: 'run', rhon: 'run',
  chess: 'chest', chests: 'chest', jest: 'chest',
  waste: 'waist', waists: 'waist', wasted: 'waist',
  cain: 'cane', kane: 'cane', canes: 'cane',
  eco: 'echo', ekko: 'echo', echoes: 'echo',
  lane: 'lanes', laines: 'lanes',
  lion: 'line', lime: 'line', lines: 'line',
  star: 'start', starts: 'start', started: 'start',
  lauder: 'louder', loader: 'louder', lowder: 'louder',
  quiet: 'quieter', quieted: 'quieter',
  yeah: 'yes', yah: 'yes', yas: 'yes', yup: 'yes', sure: 'yes',
  know: 'no', nah: 'no',
  cable: 'table', tables: 'table',
  scam: 'scan', scans: 'scan', skin: 'scan',
  paws: 'pause', pours: 'pause', pores: 'pause', paused: 'pause',
  stops: 'stop', stopped: 'stop',
  sats: 'stats', stat: 'stats',
  dun: 'done', don: 'done',
  hep: 'help', helps: 'help',
};

/** Levenshtein distance, early exit above `max`. */
function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export interface Match {
  intent: Intent;
  /** False when it took a sound-alike or near-miss to match: worth confirming. */
  exact: boolean;
  /** The alternative that matched. */
  said: string;
}

/**
 * Best intent from ALL the recogniser's alternatives, limited to what makes
 * sense at this step (a small grammar is what makes recognition accurate):
 *   1. exact keyword match, best alternative first;
 *   2. the same after common mishearings (woke -> walk, waste -> waist);
 *   3. one-letter near-misses of option words (5+ letters, two edits for 7+),
 *      only when exactly one option fits.
 */
export function matchIntent(alternatives: string[], allowed: Intent[]): Match | null {
  const alts = alternatives.map((a) => a.trim()).filter(Boolean);
  for (const a of alts) {
    const i = parseIntent(a, allowed);
    if (i) return { intent: i, exact: true, said: a };
  }
  for (const a of alts) {
    const fixed = normalise(a)
      .trim()
      .split(' ')
      .map((w) => SOUNDS_LIKE[w] ?? w)
      .join(' ');
    const i = parseIntent(fixed, allowed);
    if (i) return { intent: i, exact: false, said: a };
  }
  for (const a of alts) {
    const words = normalise(a).trim().split(' ').filter((w) => w.length >= 4);
    const found = new Set<Intent>();
    for (const [intent, phrases] of WORDS) {
      if (!allowed.includes(intent)) continue;
      for (const p of phrases) {
        if (p.includes(' ') || p.length < 5) continue;
        const max = p.length >= 7 ? 2 : 1;
        if (words.some((w) => editDistance(w, p, max) <= max)) found.add(intent);
      }
    }
    if (found.size === 1) return { intent: [...found][0], exact: false, said: a };
  }
  return null;
}

export function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/**
 * All intents found in the text, best first (longest matching phrase).
 * `allowed` restricts to what makes sense at this step of the menu.
 */
export function parseIntents(text: string, allowed?: Intent[]): Intent[] {
  const t = normalise(text);
  const hits: { intent: Intent; len: number; pos: number }[] = [];
  for (const [intent, phrases] of WORDS) {
    if (allowed && !allowed.includes(intent)) continue;
    for (const p of phrases) {
      const pos = t.indexOf(` ${p} `);
      if (pos >= 0) {
        hits.push({ intent, len: p.length, pos });
        break;
      }
    }
  }
  return hits.sort((a, b) => b.len - a.len || a.pos - b.pos).map((h) => h.intent);
}

/** One clear intent, or null when nothing (or something contradictory) was heard. */
export function parseIntent(text: string, allowed?: Intent[]): Intent | null {
  const hits = parseIntents(text, allowed);
  if (!hits.length) return null;
  // "walk or run?" - two different main choices at once is ambiguous.
  const exclusive: Intent[][] = [
    ['walk', 'run'],
    ['yes', 'no'],
    ['louder', 'quieter'],
    ['calmer', 'detailed'],
  ];
  for (const pair of exclusive) if (pair.every((i) => hits.includes(i))) return null;
  return hits[0];
}
