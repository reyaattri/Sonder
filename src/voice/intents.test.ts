import { describe, expect, it } from 'vitest';
import { matchIntent, parseIntent } from './intents';

describe('voice command understanding', () => {
  it('main choices, in natural phrasing', () => {
    expect(parseIntent('walk')).toBe('walk');
    expect(parseIntent('I want to go for a walk please')).toBe('walk');
    expect(parseIntent('run on the track')).toBe('run');
    expect(parseIntent('marathon training')).toBe('run');
  });

  it('respects what the current step allows', () => {
    expect(parseIntent('chest', ['chest', 'waist', 'hand', 'table', 'back', 'help'])).toBe('chest');
    expect(parseIntent('on my belt', ['chest', 'waist', 'hand', 'table'])).toBe('waist');
    expect(parseIntent('walk', ['chest', 'waist'])).toBeNull();
  });

  it('longer phrases win: "guide line" is a course, "surround off" is not "surround on"', () => {
    expect(parseIntent('the yellow guide line', ['lanes', 'line', 'edge', 'simulator'])).toBe('line');
    expect(parseIntent('turn off surround')).toBe('surroundOff');
    expect(parseIntent('surround sound')).toBe('surroundOn');
    expect(parseIntent('sound check')).toBe('sound');
  });

  it('ambiguous or unknown -> null (the menu then explains the taps)', () => {
    expect(parseIntent('walk or run')).toBeNull();
    expect(parseIntent('banana')).toBeNull();
    expect(parseIntent('')).toBeNull();
  });

  it('settings by voice', () => {
    expect(parseIntent('a bit louder')).toBe('louder');
    expect(parseIntent('too many beeps')).toBe('calmer');
    expect(parseIntent('turn on the white cane')).toBe('caneOn');
    expect(parseIntent('echolocation')).toBe('echoOn');
  });
});

describe('accurate speech matching (all alternatives, small grammar, mishearings)', () => {
  const MAIN = ['walk', 'run', 'live', 'simulator', 'sound', 'settings', 'back', 'help'] as const;
  it('takes the first alternative that fits this question', () => {
    expect(matchIntent(['banana bread', 'i want to walk'], [...MAIN])).toEqual({ intent: 'walk', exact: true, said: 'i want to walk' });
  });
  it('common mishearings count, flagged as not exact', () => {
    expect(matchIntent(['woke'], [...MAIN])).toMatchObject({ intent: 'walk', exact: false });
    expect(matchIntent(['on my waste'], ['chest', 'waist', 'hand', 'table'])).toMatchObject({ intent: 'waist', exact: false });
    expect(matchIntent(['turn on the kane'], ['caneOn', 'caneOff', 'done'])).toMatchObject({ intent: 'caneOn', exact: false });
  });
  it('one-letter near misses of option words, only when one option fits', () => {
    expect(matchIntent(['setings'], [...MAIN])).toMatchObject({ intent: 'settings', exact: false });
    expect(matchIntent(['simulater'], [...MAIN])).toMatchObject({ intent: 'simulator', exact: false });
  });
  it('words that fit no option at this step are not forced into one', () => {
    expect(matchIntent(['chest'], [...MAIN])).toBeNull();
    expect(matchIntent(['purple elephant'], [...MAIN])).toBeNull();
  });
  it('running commands', () => {
    const CMDS = ['describe', 'scan', 'pause', 'resume', 'stop', 'louder', 'quieter', 'stats', 'help'] as const;
    expect(matchIntent(["what's around me"], [...CMDS])?.intent).toBe('describe');
    expect(matchIntent(['scan again'], [...CMDS])?.intent).toBe('scan');
    expect(matchIntent(['how far have I gone'], [...CMDS])?.intent).toBe('stats');
    expect(matchIntent(['paws'], [...CMDS])).toMatchObject({ intent: 'pause', exact: false });
  });
});
