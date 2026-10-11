/**
 * Where frames come from: the rear camera, or a recorded test-walk video
 * (for measuring recall/false alerts, and for demos on a laptop).
 */
export interface FrameSource {
  readonly kind: 'camera' | 'file';
  readonly video: HTMLVideoElement;
  /** Which way the camera points, when the browser reports it. */
  readonly facing: 'environment' | 'user' | 'unknown';
  /** Optical zoom in use (< 1 = ultra-wide). Widens the effective field of view. */
  readonly zoom?: number;
  start(): Promise<void>;
  stop(): void;
  /** Called when the stream ends or is muted (another app took the camera, etc). */
  onLost: ((reason: string) => void) | null;
}

export class CameraError extends Error {
  constructor(
    message: string,
    readonly reason: 'denied' | 'notfound' | 'insecure' | 'unsupported' | 'busy' | 'other',
  ) {
    super(message);
  }
}

export class CameraSource implements FrameSource {
  readonly kind = 'camera';
  facing: 'environment' | 'user' | 'unknown' = 'unknown';
  label = '';
  zoom = 1;
  onLost: ((reason: string) => void) | null = null;
  private stream: MediaStream | null = null;

  /** `deviceId` picks a specific camera (e.g. a USB webcam); empty = rear camera if there is one. */
  constructor(
    readonly video: HTMLVideoElement,
    private readonly deviceId = '',
    /** Track mode asks for 60 fps: faster lane updates while running. */
    private readonly frameRate = 30,
    /** Use the widest zoom the camera offers (ultra-wide lens on many phones). */
    private readonly wide = false,
  ) {}

  get active(): boolean {
    return this.stream?.active ?? false;
  }

  async start(): Promise<void> {
    if (!window.isSecureContext) throw new CameraError('Camera needs a secure (https) page', 'insecure');
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('Camera not supported', 'unsupported');
    try {
      // audio: false matters for Bluetooth: opening a microphone would switch
      // most Bluetooth headsets into mono "hands-free" mode and kill stereo.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: this.frameRate },
        },
      });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError' || name === 'SecurityError')
        throw new CameraError('Camera permission was denied', 'denied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError')
        throw new CameraError('No camera found', 'notfound');
      if (name === 'NotReadableError') throw new CameraError('Camera is in use by another app', 'busy');
      throw new CameraError(String(e), 'other');
    }
    const track = this.stream.getVideoTracks()[0];
    const fm = track.getSettings().facingMode;
    this.facing = fm === 'environment' ? 'environment' : fm === 'user' ? 'user' : 'unknown';
    this.label = track.label;
    // Wider view, more like a compound eye: many phones expose the ultra-wide
    // lens as zoom < 1 on the main camera track.
    if (this.wide) {
      const caps = track.getCapabilities?.() as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
      if (caps?.zoom && caps.zoom.min < 1) {
        try {
          await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min } as MediaTrackConstraintSet] });
          this.zoom = caps.zoom.min;
        } catch {
          /* not allowed on this device: keep the normal view */
        }
      }
    }
    track.addEventListener('ended', () => this.onLost?.('ended'));
    track.addEventListener('mute', () => this.onLost?.('muted'));
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await waitForSize(this.video);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

export class FileSource implements FrameSource {
  readonly kind = 'file';
  readonly facing = 'unknown';
  onLost: ((reason: string) => void) | null = null;
  private url: string | null = null;

  constructor(
    readonly video: HTMLVideoElement,
    private readonly file: File,
  ) {}

  async start(): Promise<void> {
    this.url = URL.createObjectURL(this.file);
    this.video.srcObject = null;
    this.video.src = this.url;
    this.video.loop = true;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await waitForSize(this.video);
  }

  stop(): void {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

/**
 * A real-world still photo (e.g. Project Guideline's test frame), streamed
 * like a camera so the full pipeline runs on it.
 */
export class ImageSource implements FrameSource {
  readonly kind = 'file';
  readonly facing = 'unknown';
  onLost: ((reason: string) => void) | null = null;
  readonly image = new Image();
  private canvas = document.createElement('canvas');
  private timer: number | undefined;
  private stream: MediaStream | null = null;

  constructor(
    readonly video: HTMLVideoElement,
    private readonly url: string,
  ) {}

  async start(): Promise<void> {
    this.image.src = this.url;
    await this.image.decode();
    this.canvas.width = this.image.naturalWidth;
    this.canvas.height = this.image.naturalHeight;
    const g = this.canvas.getContext('2d')!;
    const draw = () => g.drawImage(this.image, 0, 0);
    draw();
    this.timer = window.setInterval(draw, 1000 / 30); // keep frames flowing
    this.stream = this.canvas.captureStream(30);
    this.video.removeAttribute('src');
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await waitForSize(this.video);
  }

  stop(): void {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

/**
 * Cues must use the LISTENER's left and right. A camera pointing the way you
 * face (phone on a lanyard) already does; a camera looking at you (laptop
 * webcam) sees the world mirrored, so its image is flipped.
 */
export function shouldMirror(
  kind: FrameSource['kind'],
  facing: FrameSource['facing'],
  setting: 'auto' | 'same' | 'toward',
): boolean {
  if (kind !== 'camera') return false;
  if (setting !== 'auto') return setting === 'toward';
  return facing !== 'environment'; // laptop webcams report 'user' or nothing
}

/** Cameras on this device (labels appear once camera permission is granted). */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
}

function waitForSize(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => (video.videoWidth > 0 ? resolve() : requestAnimationFrame(check));
    check();
  });
}

/** Keeps the screen (and so the camera) on while walking (US-1.3). */
export class WakeLock {
  private lock: WakeLockSentinel | null = null;
  private wanted = false;

  async acquire(): Promise<boolean> {
    this.wanted = true;
    return this.request();
  }

  release(): void {
    this.wanted = false;
    void this.lock?.release();
    this.lock = null;
  }

  /** Locks are dropped when the page is hidden; call again on return. */
  async reacquire(): Promise<void> {
    if (this.wanted && !this.lock) await this.request();
  }

  get held(): boolean {
    return this.lock !== null;
  }

  private async request(): Promise<boolean> {
    if (!('wakeLock' in navigator)) return false;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => (this.lock = null));
      return true;
    } catch {
      return false;
    }
  }
}
