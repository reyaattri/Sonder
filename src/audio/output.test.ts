import { describe, expect, it } from 'vitest';
import { classifyOutput } from './engine';

describe('output classification (Bluetooth troubleshooting)', () => {
  it('tells stereo Bluetooth from hands-free (mono) and laptop speakers', () => {
    expect(classifyOutput('Headphones (ULT WEAR)')).toBe('bt-stereo');
    expect(classifyOutput('Headset (ULT WEAR Hands-Free)')).toBe('bt-handsfree');
    expect(classifyOutput('Speakers (Realtek(R) Audio)')).toBe('speakers');
    expect(classifyOutput('AirPods Pro')).toBe('bt-stereo');
    expect(classifyOutput('Headphones (USB Audio)')).toBe('headphones');
  });
});
