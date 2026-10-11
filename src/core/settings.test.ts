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
    const raw: Partial<Settings> = { model: 'efficientdet_lite0', heartbeat: true, looming: false, settingsVersion: 3 };
    const s = migrate({ ...DEFAULT_SETTINGS, ...raw }, raw);
    expect(s.model).toBe('efficientdet_lite0');
    expect(s.heartbeat).toBe(true);
    expect(s.looming).toBe(false);
  });
});

describe('v7: purple guide line removed', () => {
  it('a saved purple line colour becomes yellow', () => {
    const raw = { settingsVersion: 6, lineColor: 'purple' } as unknown as Partial<Settings>;
    expect(migrate({ ...DEFAULT_SETTINGS, ...raw } as Settings, raw).lineColor).toBe('yellow');
  });
});

describe('v9: opens on the voice menu', () => {
  it('the voice menu is the home page (the visual menu stays one tap away)', () => {
    const raw = { settingsVersion: 8, voiceMenu: false } as unknown as Partial<Settings>;
    expect(migrate({ ...DEFAULT_SETTINGS, ...raw } as Settings, raw).voiceMenu).toBe(true);
    expect(DEFAULT_SETTINGS.voiceMenu).toBe(true);
  });
});
