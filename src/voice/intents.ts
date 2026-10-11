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
  | 'no';

const WORDS: [Intent, string[]][] = [
  // Multi-word phrases first (they win over single words).
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
