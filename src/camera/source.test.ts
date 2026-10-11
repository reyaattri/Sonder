import { describe, expect, it } from 'vitest';
import { shouldMirror } from './source';

describe('camera mirroring (listener left/right)', () => {
  it('phone rear camera points the way you face: no flip', () => {
    expect(shouldMirror('camera', 'environment', 'auto')).toBe(false);
  });
  it('laptop webcam looks at you: flip', () => {
    expect(shouldMirror('camera', 'user', 'auto')).toBe(true);
    expect(shouldMirror('camera', 'unknown', 'auto')).toBe(true);
  });
  it('manual setting wins', () => {
    expect(shouldMirror('camera', 'user', 'same')).toBe(false);
    expect(shouldMirror('camera', 'environment', 'toward')).toBe(true);
  });
  it('recorded test videos are never flipped', () => {
    expect(shouldMirror('file', 'unknown', 'toward')).toBe(false);
  });
});
