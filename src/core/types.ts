/** Axis-aligned box in normalized frame coordinates (0..1, origin top-left). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One raw detector output. Every detector returns these via `detect(frame)`. */
export interface Detection {
  box: Box;
  label: string;
  score: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/** Sound/priority category from the PRD sound-design table. */
export type Category = 'person' | 'vehicle' | 'static';

export type Zone = 'left' | 'center' | 'right';

/** Coarse distance bands: estimates are rough by design, only the ranking matters. */
export type DistanceBand = 'far' | 'mid' | 'near' | 'veryNear';

export type ModelId = 'efficientdet_lite0' | 'efficientdet_lite2' | 'yolox_nano';

export type AudioMode = 'spatial' | 'stereo';
export type SoundStyle = 'classic' | 'soft';
export type Sensitivity = 'low' | 'medium' | 'high';
export type Verbosity = 'off' | 'urgent' | 'all';
