import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrate, SETTINGS_VERSION, type Settings } from './settings';

describe('settings migration', () => {
  it('v1 saved defaults move to the new accurate model and quiet heartbeat', () => {
    const raw: Partial<Settings> = { model: 'efficientdet_lite0', heartbeat: true, volume: 0.5 };
    const s = migrate({ ...DEFAULT_SETTINGS, ...raw }, raw);
    expect(s.model).toBe('efficientdet_lite2');
    expect(s.heartbeat).toBe(false);
    expect(s.volume).toBe(0.5); // user choices kept
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('v2 settings are left alone', () => {
    const raw: Partial<Settings> = { model: 'efficientdet_lite0', heartbeat: true, settingsVersion: 2 };
    const s = migrate({ ...DEFAULT_SETTINGS, ...raw }, raw);
    expect(s.model).toBe('efficientdet_lite0');
    expect(s.heartbeat).toBe(true);
  });
});
