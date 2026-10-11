import { describe, expect, it } from 'vitest';
import { nextGuidance } from './guidance';
import type { PolicyOutput } from './policy';

const out = (o: Partial<PolicyOutput>): PolicyOutput => ({
  sources: [],
  blocked: false,
  guideSide: null,
  noWayAround: false,
  guideFrom: null,
  unexplainedLooming: null,
  pacing: null,
  ...o,
});

describe('spoken guidance state machine', () => {
  it('stop -> blockage gone: tells you to move again', () => {
    const a = nextGuidance(null, out({ blocked: true, noWayAround: true }), 'Person');
    expect(a.text).toMatch(/No way around\. Stop\./);
    expect(nextGuidance('none', out({ blocked: true, noWayAround: true }), 'Person').text).toBeNull(); // no repeats
    const b = nextGuidance('none', out({}), 'Person');
    expect(b).toMatchObject({ key: null, resume: true });
    expect(b.text).toMatch(/Way opened\. Go ahead carefully/);
    expect(b.text).not.toMatch(/clear|safe/i);
  });

  it('stop -> a side opens: tells you which way', () => {
    const r = nextGuidance('none', out({ blocked: true, guideSide: 'right' }), 'Person');
    expect(r).toMatchObject({ key: 'right', text: 'Way around opened. Step right.', resume: true });
  });

  it('step left -> past it: tells you to carry on forward', () => {
    expect(nextGuidance(null, out({ blocked: true, guideSide: 'left' }), 'Chair').text).toBe('Chair ahead, step left.');
    expect(nextGuidance('left', out({}), 'Chair')).toMatchObject({ text: null, resume: true }); // a chime, no words
  });

  it('nothing to say when nothing changed', () => {
    expect(nextGuidance(null, out({}), 'x').text).toBeNull();
    expect(nextGuidance('left', out({ blocked: true, guideSide: 'left' }), 'x').text).toBeNull();
  });
});
