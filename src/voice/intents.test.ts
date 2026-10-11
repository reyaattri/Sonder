import { describe, expect, it } from 'vitest';
import { parseIntent } from './intents';

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
