import type { PolicyOutput } from './policy';

/** What the user was last told about getting past a blockage. */
export type GuidanceKey = 'none' | 'left' | 'right' | `loom-${string}` | null;

export interface GuidanceSpeech {
  key: GuidanceKey;
  /** Text to speak now, or null for nothing new. */
  text: string | null;
  /** Play the "way opened" chime with it. */
  resume: boolean;
}

/**
 * Spoken guidance as a small state machine:
 *
 *   blocked, no way around   -> "Person ahead. No clear way around on the path. Stop or wait."
 *   ...then a side opens     -> "Way around opened. Step left."
 *   ...or the blockage goes  -> "The way ahead has opened. Continue forward, carefully."
 *   blocked, step left       -> "Person ahead, step left."
 *   ...then you're past it   -> "Passed. Continue forward."
 *   unexplained looming side -> "Something coming from the left."
 *
 * Never says the way is "clear" or "safe": only that the blockage it saw is gone.
 */
export function nextGuidance(prev: GuidanceKey, p: PolicyOutput, what: string): GuidanceSpeech {
  if (p.blocked && p.noWayAround) {
    return prev === 'none'
      ? { key: 'none', text: null, resume: false }
      : { key: 'none', text: `${what} ahead. No clear way around on the path. Stop or wait.`, resume: false };
  }
  if (p.blocked && p.guideSide) {
    if (prev === p.guideSide) return { key: prev, text: null, resume: false };
    if (prev === 'none') return { key: p.guideSide, text: `Way around opened. Step ${p.guideSide}.`, resume: true };
    return { key: p.guideSide, text: `${what} ahead, step ${p.guideSide}.`, resume: false };
  }
  if (!p.blocked) {
    if (prev === 'none') return { key: null, text: 'The way ahead has opened. Continue forward, carefully.', resume: true };
    if (prev === 'left' || prev === 'right') return { key: null, text: 'Passed. Continue forward.', resume: true };
  }
  if (p.unexplainedLooming && p.unexplainedLooming !== 'center') {
    const key = `loom-${p.unexplainedLooming}` as const;
    return prev === key
      ? { key, text: null, resume: false }
      : { key, text: `Something coming from the ${p.unexplainedLooming}.`, resume: false };
  }
  // Still blocked with no decision yet (e.g. path model unsure): keep state.
  return { key: p.blocked ? prev : null, text: null, resume: false };
}
