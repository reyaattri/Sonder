# EchoPath

Real-time, on-device audio navigation for people who are blind or have low vision.
EchoPath turns the phone camera into a pair of ears: people and obstacles become
directional sounds in your headphones. All processing happens in the browser, and
no video ever leaves the device.

EchoPath has two modes, chosen on the home screen:

- **Walk**: everyday walking and jogging. People, vehicles and obstacles become spatial sounds.
- **Track run**: lane guidance on a running track (the KineticSpatial plan). Silent while you are centred; a spatial ping and a vibration from the side you're drifting toward. Live pace, distance, cadence, laps and heart rate are spoken on a schedule.

> EchoPath is a **supplementary aid**. It does not replace a cane, a guide dog or
> sighted assistance, and it can miss obstacles (glass, stairs, drop-offs, low light).

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 (laptop, camera works on localhost)
npm run dev:https    # https on your LAN, for testing on a phone (accept the self-signed cert)
npm test             # unit tests (geometry, tracker, cue policy, speech, governor, YOLOX decode)
npm run build        # production build + service worker into dist/
```

`npm run dev`, `dev:https` and `build` first run `scripts/fetch-assets.mjs`. It copies the
MediaPipe and ONNX Runtime WASM into `public/vendor/` and downloads the three detector
models into `public/models/` (all Apache-2.0). Both folders are git-ignored.

### Track run mode

Strap the phone to your chest, back camera forward and tilted slightly down so it sees the lane lines a few steps ahead.

- **Lane detection** (`src/track/lane.ts`) is classic computer vision on a 160 px frame, every camera frame (requested at 60 fps):
  1. an adaptive white-paint mask;
  2. a Hough vote for near-vertical lines;
  3. least-squares refinement;
  4. the nearest line on each side, preferring the pair matching the remembered lane width so another runner's legs aren't mistaken for a line;
  5. one-frame jumps rejected.
- **Feedback** (`src/track/feedback.ts`):
  - Silent inside a free zone (12 % of the lane by default).
  - Beyond that, a broadband spatial click from the side of the line you're drifting onto. It repeats every 450 ms, then every 220 ms, then 110 ms as you drift further, and is triggered by the *predicted* position about 0.35 s ahead (from heading and speed).
  - One vibration for a left drift, two for a right drift; the patterns get longer when stronger.
  - A soft rising tone when you're back in the centre.
  - The cue side can instead point toward where to steer (Settings → Track run).
- **Run metrics** (`src/track/run.ts`, `devices.ts`):
  - Distance and pace come from GPS (inaccurate fixes and jumps rejected), or from steps × step length when GPS is unavailable (indoor tracks).
  - Cadence comes from the accelerometer.
  - Heart rate comes from any Bluetooth chest strap or watch broadcasting the standard Heart Rate service (Chrome/Edge; not on iPhone).
  - Stats are spoken every lap, every km or every N minutes. Optional high-heart-rate alert.
  - Double-tap or a headphone "next track" press asks for stats any time.
- **Runner ahead**: the object detector runs on the **CPU** in its worker, about 3 times a second, so it never competes with the GPU for camera frames. It says "Runner ahead, 3 metres."

Measured on a synthetic 60 fps track, with the runner swaying ±0.35 lane widths, heading changes, camera bob, and another runner crossing the lane:
- 29–52 lane updates per second, with lane detection at 3.3–3.7 ms per frame;
- median position error 0.004 lane widths (90th percentile 0.04);
- 100 % of pings on the correct side;
- cadence read 168 at a simulated 168 steps/min.

Not achievable from a browser: the pitch's "under 30 ms" end to end. The camera alone adds about 30–60 ms, and Bluetooth audio 100–250 ms. Vibration is not available on iPhones (sound only there).

### Running it live

**Laptop with webcam (demo table).** Run `npm run dev` and open `http://localhost:5173` in Chrome or Edge. The browser address bar is the only place to grant camera access; embedded previews block it. Settings → *Camera* picks a USB webcam. *Camera direction* decides left/right:
- **Automatic** treats a webcam as pointing toward you, so the image is mirrored and cues match the listener's own left and right.
- **Points the way I face** suits a camera pointed out into the room from beside the listener.

**Phone (walking).** Run `npm run dev:https`, then open the printed `https://<your-ip>:5173` on the phone, on the same Wi‑Fi, and accept the certificate warning. On the home screen, pick where the phone is worn:

| Mount | Setup | Pause | "What's around me?" |
|---|---|---|---|
| **Chest** | Lanyard or chest strap, back camera facing forward | Press and hold the screen (0.7 s) | Double-tap |
| **Waist** | Belt clip, back camera forward, tilted slightly up | Press and hold | Double-tap |
| **In hand** | Held at chest height, pointing ahead | Double-tap | Press and hold |
| **On a table** | Demo: phone or laptop facing the room | Double-tap | Press and hold |

When worn, the on-screen buttons stay hidden until you pause, so bumps against clothing can't press Stop. Bluetooth headphone buttons also work: play/pause pauses or resumes, and next/previous track asks "What's around me?" (best effort; depends on the browser). Chest and waist mounts turn on:
- **walking detection** from the accelerometer (step cadence → speed), which gives static obstacles ahead a time-to-contact and spoken warnings;
- **tilt guidance**, which says so if the camera droops toward the floor or points at the sky for 3 s;
- a **soft tick** every 6 s while nothing is detected, so silence is never confused with a crash (Settings → Wearing).

Low-battery warnings sound at 20 % and 10 %.

**Bluetooth headphones.**
1. Pair them in the OS Bluetooth settings.
2. Open **Sound check** on the home screen. It shows where sound is going, whether that output is stereo, and the reported delay.
3. Press **Sweep**: a cue should travel from your left, through ahead, to your right and back. **Learn the sounds** plays each cue type.
4. If the headphones connected after EchoPath started, press **Reconnect sound**. EchoPath also does this automatically when the OS reports a device change.

**If you can't hear direction over Bluetooth:**
- The output is probably mono. On Windows each Bluetooth headset appears twice. Choose the *Headphones / Stereo* entry, not *Headset / Hands-Free*.
- Close any call or meeting app using the headset microphone.
- Make sure *Mono audio* is off in accessibility settings.
- Sound check flags all of these, and the running screen shows a red **Mono** chip.

Spatial voices run through HRTF **plus** an extra left/right level boost, and far sounds are slightly darker. Bluetooth earbuds often flatten HRTF alone; the boost keeps the side unmistakable. Directions are also widened by default (Settings → *Direction width*, 2.2×). The camera only spans about ±32°, and real HRTF at that angle sounds nearly centered on earbuds; widening puts an object at the frame edge about 66° to that side.

EchoPath never opens the microphone, so headsets stay in stereo (A2DP) mode rather than switching to mono hands-free. Expect roughly 100–250 ms of extra Bluetooth delay; the stats panel shows the output delay the browser reports. If headphones disconnect mid-session, an attention sound and spoken notice play.

**Appearance.** Follows the device's light or dark setting by default; Settings → *Appearance* can force either.

**No camera?** Settings → *Use a test video instead of the camera* plays a recorded walk
through the full pipeline. Settings → *Download session log* exports every cue, spoken
warning and system event, with timestamps and capture-to-sound latency. Use it to score
recall and false alerts against a labelled test walk.

### Walk mode: fewer, better beeps

Settings → *How often cues sound* defaults to **Calm**:
- each object gets one short burst;
- the same object repeats only when it is clearly closer, and not within 4 s;
- nothing beyond 4.5 m sounds;
- obstacles off to the side stay quiet unless within 1.8 m.

Blocked path and "very near and approaching" are never suppressed. Pulse rates run 0.8–4 Hz (was 1–6), and the heartbeat tick is off by default.

Accuracy:
- the most accurate model (EfficientDet-Lite2) is the default, switching itself to Lite0 if this device is too slow;
- objects must be seen on 3 frames before they cue;
- labels are settled by vote;
- boxes are smoothed more;
- Settings → *Distance calibration* fits the camera's field of view from one person standing at a measured distance.

## How it works

```
camera ─▶ resize (canvas) ─▶ Web Worker: detect(frame) ─▶ filter (corridor, size, score)
      ─▶ IoU tracker (ids, distance, azimuth, time-to-contact) ─▶ cue policy (priority, ≤3 sources)
      ─▶ Web Audio: HRTF/stereo voices ─▶ cue bus (ducked during speech) ─▶ master (safe max) ─▶ limiter
                                     └─▶ spoken warnings (speechSynthesis), V2
```

| Module | What it does |
|---|---|
| `src/detect/` | `Detector` contract (`detect(frame)` → boxes, labels, scores). MediaPipe EfficientDet-Lite0/Lite2 and YOLOX-nano (ONNX Runtime, WebGPU → WASM). Runs in a module worker with a main-thread fallback, and warms up during load. |
| `src/perception/` | Geometry (θ = atan((x−w/2)/f), d ≈ f·H/h), zones and corridor, the tracker, time-to-contact (τ = s / (ds/dt) on apparent size s = 1/d, robust to clipped boxes), low-light/blur check, looming detector. |
| `src/cues/policy.ts` | Rate-limited cues: first entry, then only when markedly closer or changing zone. Blocked-path buzz plus a guide tone to the freer side. Priority blocked > guide > vehicle > person > static, max 3. |
| `src/audio/` | Synthesized timbres (marimba person, hum-with-sweep vehicle, wooden tock static, harsh buzz, rising guide, earcons), lookahead scheduler, HRTF `PannerNode` or `StereoPannerNode`, −12 dB ducking, limiter, hard gain ceiling. |
| `src/speech/` | "Person, left, about three seconds" warnings (τ < 4 s, high confidence, verbosity off/urgent/all, ≤ 1 utterance / 2 s, most urgent first). |
| `src/perf/` | FPS and latency metrics. Quality governor: below 12 FPS for 3 s → lower input resolution, then a smaller model, telling the user once. |
| `src/sensors/motion.ts` | Accelerometer step detector (walking, cadence, speed) and camera tilt from gravity. |
| `src/perception/egomotion.ts` | Static-obstacle time-to-contact from walking speed; the spoken "what's around me" summary. |
| `src/app/session.ts` | The frame loop, watchdog (fail loudly within ~1 s), camera-loss handling, low-light and tilt warnings, heartbeat, cue log. |
| `src/ui/radar.ts` | Top-down radar of what EchoPath hears (for sighted helpers and demos). |
| `src/main.ts` | Screens (home with ready check → safety notice → sound check → running), mount-aware gestures, headphone media buttons, device changes, battery, settings. |

## PRD coverage

**F1: Mobile web app.** No-install PWA with service-worker precache. Large Start button. Spoken guidance before the camera prompt, and spoken retry help if it is denied. Rear camera by default. Screen Wake Lock. Audible warning when the camera drops or the page is backgrounded. Full-screen double-tap pause with distinct pause/resume earcons. VoiceOver/TalkBack double-tap and keyboard activation toggle it with a single activation.

**F2: Detection.** COCO person/vehicle/furniture/sign classes. Left/center/right zones, path corridor and minimum box size, all adjustable. Tracker-based cue limits, max 3 sources. *Stretch:* "large looming surface" via scale-matched image expansion (Settings → experimental).

**F3: Directional cues.** Zone pan −1/0/+1. Blocked-path buzz plus guide tone in the freer ear. Distinct timbres per category. Pulse rate 1 Hz (> 5 m) → 6 Hz (< 1 m). Left-then-right headphone check that warns about mono/speaker or swapped earbuds.

**F4: On-device inference.** No runtime network use: models and WASM are served from the app and cached. Three swappable models behind one contract. Adaptive quality step-down and step-up.

**F5: Spatial audio.** HRTF panner per tracked object from box azimuth and field of view (default 65°, along the long side, adjustable). Gain, pitch and pulse rate follow distance. Smoothed position updates (no zipper noise). Settings for mode, volume, sensitivity and sound style persist on the device.

**F6 (V2): Spoken warnings.** Time-to-contact from growth smoothed over ≥ 5 frames, speech ducks beeps by 12 dB, verbosity setting.

**Safety and privacy.** First-run disclaimer read aloud and confirmed. Never says "path clear". Fixed safe maximum gain plus a limiter. Debug overlay (boxes, zones, distances, τ, FPS, latency) off by default. No accounts, no analytics.

## Verified so far (desktop Chromium, scripted scenes)

- All three models detect the same objects on a reference photo (bus plus 3 people), running in the worker on GPU/WebGPU with 0 network requests during inference.
- End to end through the real camera code path (canvas-fed `getUserMedia`):
  - a person crossing produces left → center → right cues with azimuth sweeping −25° → +20°;
  - an approaching person triggers the blocked buzz, the guide tone and the spoken warning *"Person, center, about three seconds"*;
  - capture→sound latency is p50 ≈ 145–180 ms, p95 ≈ 175–217 ms (target ≤ 250 ms).
- Worn chest mode with simulated walking (accelerometer events at 1.8 steps/s): detected as walking at 1.2 m/s, tilt −3°, controls hidden until pause, and "What's around me?" answered *"Person, ahead, about 5 metres, approaching."*
- Track mode: see the measurements above.
- 79 unit tests.

## Not yet verified / known gaps

- **Real phones.** FPS on the desktop preview was 6–14 (about 85–115 ms inference). The 15 FPS target needs measuring on the demo phones. Use Settings → stats, or the debug overlay.
- **Offline / airplane mode.** The service worker and precache manifest build correctly, but the preview browser used during development does not run service workers. Verify on a phone: load once, enable airplane mode, reload.
- **Screen readers and listening tests.** Labels, focus moves and live regions are in place, but nothing has been tested with VoiceOver/TalkBack users or a 5-person listening test.
- **Speech fallback.** Without `speechSynthesis`, warnings become a distinct "approaching" sound from that side, and text goes to the ARIA live region. There are no recorded voice clips.
- **Walking speed** assumes a 0.65 m step and is tuned on simulated data. Check it on a real walk.
- **Headphone media buttons** depend on the browser exposing a media session for a silent audio track. Chrome on Android usually does; iOS may not.
- **Motion permission.** iPhones ask for motion access on the Start tap. Some embedded browsers deny it, and then walking detection is simply off.
- **Looming detector.** Experimental, and not tested against real walls or glass. Featureless glass gives no signal.
- **Bluetooth headphones** add ~100 ms or more of output latency. Use wired or low-latency earbuds for the demo.
