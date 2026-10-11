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

describe('more Bluetooth names (from the sai branch), hands-free still detected first', () => {
  it('classifies common earphones as stereo Bluetooth', () => {
    expect(classifyOutput('Galaxy Buds2 Pro')).toBe('bt-stereo');
    expect(classifyOutput('Shokz OpenRun')).toBe('bt-stereo');
    expect(classifyOutput('JBL Tune 510BT')).toBe('bt-stereo');
    expect(classifyOutput('Sony WH-1000XM5')).toBe('bt-stereo');
    expect(classifyOutput('Headset (Sony WH-1000XM5 Hands-Free)')).toBe('bt-handsfree');
  });
});

describe('Bluetooth auto-select', () => {
  // Pretend the browser can route to a chosen device.
  const g = globalThis as unknown as { AudioContext?: unknown };
  const had = g.AudioContext;
  const setup = async (labels: string[]) => {
    g.AudioContext = class {
      setSinkId() {}
    };
    const { AudioEngine } = await import('./engine');
    const e = new AudioEngine();
    const chosen: string[] = [];
    e.getAudioOutputs = async () => labels.map((l, i) => ({ deviceId: `d${i}`, label: l, kind: classifyOutput(l) }));
    e.setOutput = async (id: string) => void chosen.push(id);
    return { e, chosen };
  };

  it('picks the STEREO headphones entry, never the mono hands-free one', async () => {
    const { e, chosen } = await setup(['Speakers (Realtek(R) Audio)', 'Headset (ULT WEAR Hands-Free)', 'Headphones (ULT WEAR)']);
    expect(await e.autoSelectBluetooth()).toEqual({ deviceId: 'd2', label: 'Headphones (ULT WEAR)' });
    expect(chosen).toEqual(['d2']);
  });

  it('only a hands-free entry or only speakers: leaves the output alone', async () => {
    let r = await setup(['Speakers (Realtek(R) Audio)', 'Headset (ULT WEAR Hands-Free)']);
    expect(await r.e.autoSelectBluetooth()).toBeNull();
    expect(r.chosen).toEqual([]);
    r = await setup(['Speakers (Realtek(R) Audio)']);
    expect(await r.e.autoSelectBluetooth()).toBeNull();
    g.AudioContext = had;
  });
});
