import { describe, expect, it } from 'vitest';
import { TalkPolicy } from './talkPolicy';

describe('talk only when it matters', () => {
  it('STOP always gets through, but is not repeated within 4 s', () => {
    const p = new TalkPolicy();
    expect(p.allow('warn', 'Person ahead.', 0)).toBe(true);
    expect(p.allow('stop', 'No clear way around. Stop.', 100)).toBe(true);
    expect(p.allow('stop', 'No clear way around. Stop.', 2000)).toBe(false);
    expect(p.allow('stop', 'No clear way around. Stop.', 5000)).toBe(true);
  });

  it('steering is at least 5 s apart', () => {
    const p = new TalkPolicy();
    expect(p.allow('steer', 'Step left.', 0)).toBe(true);
    expect(p.allow('steer', 'Step right.', 3000)).toBe(false);
    expect(p.allow('steer', 'Step right.', 5500)).toBe(true);
  });

  it('warnings and notes need quiet first', () => {
    const p = new TalkPolicy();
    expect(p.allow('steer', 'Step left.', 0)).toBe(true);
    expect(p.allow('warn', 'Bicycle ahead.', 4000)).toBe(false);
    expect(p.allow('warn', 'Bicycle ahead.', 9000)).toBe(true);
    expect(p.allow('info', 'Leaves on the path.', 12000)).toBe(false);
    expect(p.allow('info', 'Leaves on the path.', 18000)).toBe(true);
  });

  it('"way opened" only follows a stop', () => {
    const p = new TalkPolicy();
    expect(p.allow('resume', 'Way opened.', 0)).toBe(false);
    p.allow('stop', 'Stop.', 1000);
    expect(p.allow('resume', 'Way opened.', 3000)).toBe(true);
  });

  it('at most 4 non-urgent sentences in 30 s', () => {
    const p = new TalkPolicy();
    let said = 0;
    for (let t = 0; t < 30000; t += 500) if (p.allow('steer', `Step ${t % 1000 ? 'left' : 'right'} ${t}.`, t)) said++;
    expect(said).toBeLessThanOrEqual(4);
  });
});
