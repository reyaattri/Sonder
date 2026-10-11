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

### Walk mode: two visual pathways (FLOCK-EYE ideas)

Walk mode sees the world through two complementary pathways, like the FLOCK-EYE pod:

1. **Semantic pathway**: what is there and where. The object detector and tracker, unchanged.
2. **Looming pathway**, inspired by the locust's Lobula Giant Movement Detector (`src/perception/lgmd.ts`). It doesn't care *what* something is, only that it is rushing at you, so it catches things the detector can't name: poles, doors, branches, a missed cyclist. How it works:
   - **Layers:** photoreceptor change → delayed lateral inhibition → summation (excitation that outruns inhibition) → grouping (removes speckle).
   - **Compound-eye sectors:** left, centre and right each get their own unit, so a threat has a direction.
   - **Feed-forward inhibition:** whole-field changes (camera shake, flicker, exposure) are ignored.
   - **Adaptive baseline:** steady background motion while walking is learned and ignored.
   - **Approach vs passing:** excitation must keep *rising*, and spread outward faster than it drifts sideways. Expanding means looming; sliding across means passing.

**Fusion.** Looming in a sector with a tracked object makes that object's cue urgent. Looming nothing explains is an unknown threat: straight ahead it triggers the blocked-path buzz; from the side it plays a rising "whoosh" from that side and says "Something coming from the left."

**Wide coverage.** Where a phone exposes its ultra-wide lens as zoom < 1, EchoPath uses it (Settings → *Use the ultra-wide lens*) and corrects distance and direction for the wider field of view.

Tested on live (synthetic) video:
- still scene: 0 false alarms;
- textured object passing: spikes, but correctly *not* looming;
- unrecognised object rushing at the camera: looming in the centre sector, triggering the blocked-path warning.

### Walk mode: guidance that keeps you on the path

"Step left/right" used to mean "the side with fewer objects", which could send you onto grass or into the road. The walkable-path model (`src/perception/freespace.ts`) fixes this:

- The ground right in front of your feet is the path you're on.
- Every patch of the ground region is compared with it by colour and texture. Brightness may vary, so shadows still count as path; the reference uses medians, so a strip of verge can't contaminate it.
- When something blocks you, EchoPath measures the walkable width **beside it, at its feet**, on each side, and checks that the path carries on ahead there.
- It guides only toward a side with at least about 0.6 m of path to pass. With no such side, it says "Person ahead. No clear way around on the path. Stop or wait." and plays no guide tone.
- Decisions must hold for a few frames before they change, so someone moving can't flip "step left" into "no way around".
- It speaks the choice once: "Person ahead, step left."
- When the path model can't be trusted (feet area hidden for about a second), it falls back to the old clutter rule.

Your scenario on a synthetic path (person standing on the right half of a path with grass beyond): **step left in 48 of 48 frames**, decided by the path model.

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

### Depth without LiDAR: virtual white cane and echolocation

The White Cane app reads the iPhone LiDAR scanner through ARKit. Browsers cannot access LiDAR (and Android WebXR depth needs a full-screen AR session). Instead, EchoPath does what Google Project Guideline does: a depth AI (**Depth Anything V2 Small**, Apache-2.0) estimates depth from the camera image, and the relative output is turned into **metres** by RANSAC-fitting `1/range = a*disparity + b` on pixels whose true distance is known from the ground geometry (camera tilt from the accelerometer, height from the mount). Every pixel then has a 3D position. It runs in its own worker on WebGPU (fp16), falling back to WASM (int8). On this laptop it takes about 65–90 ms per frame.

- **Virtual white cane.** The nearest obstacle of any kind in your path (wall, pole, open door, branch) becomes a smooth sonar tone, higher and quicker as it nears, from its direction. Head-height hazards, which a real cane misses, add a bright shimmer and a spoken warning. Unrecognised close obstacles straight ahead also trigger the blocked-path guidance.
- **Synthetic echolocation** (Settings, *Echolocation clicks*). A soft click, then an echo from each surface: delayed by its distance (time-stretched ×6 so you can hear it), coming from its direction, fainter and duller further away.
- Tested on a rendered scene with a runner 3 m ahead: measured at 2.7 m (body front), head-height part flagged, alignment quality 1.0.

### Track mode: Project Guideline-level detection and a simulator

- **World model** (`src/track/world.ts`), following Project Guideline:
  - line keypoints are projected onto the ground in metres;
  - they are accumulated across frames, moved by your own motion (speed and gyroscope turn);
  - a RANSAC curve is fitted;
  - control comes from look-ahead (pure-pursuit) steering, with turn detection and a Kalman-smoothed offset;
  - lane crossings are counted, so guidance brings you back to *your* lane;
  - STOP fires if the line is lost while moving or you leave the lane.
- **Smooth guide tone** (default): one continuous tone that glides from low to high as the needed correction grows, swells softly instead of beeping, comes from the side to steer toward, and fades to silence on line. A soft edge warning sounds in the other ear. Speech only for a big drift that lasts: "Move left."
- **Simulator** (Home, *Practice and real-world tests*):
  - a real 400 m track (84.39 m straights, 36.5 m bend radius, 1.22 m lanes), or a road with a yellow guide line;
  - rendered from a chest camera into the **real** pipeline, with simulated step bounce, tilt and turn rate;
  - steer by hand, or let the autopilot (a runner who only hears EchoPath) run.
  - Measured: **in lane 94.5 % over 170 m including a full bend; position estimate within 3–9 cm of the truth.**

### Google Project Guideline: their model, their sounds, their test data

[Project Guideline](https://github.com/google-research/project-guideline) (Apache-2.0) is Google's system for blind runners following a painted line. EchoPath uses its released pieces directly; `npm run setup:assets` downloads them.

- **Guideline segmentation model** (`guideline.tflite`, DeepLab-style, 513×513, two masks; mask 1 is the line), run with MediaPipe ImageSegmenter in a worker, as Project Guideline does. Their block-keypoint extraction is ported (`src/track/pgKeypoints.ts`).
  - **GPU self-test.** On this Windows/Chrome laptop the GPU delegate runs the model but returns garbage masks. At start-up the worker runs Google's real test photo on the GPU, and keeps the GPU only if it finds the line where Google's labels say it is. Otherwise it uses the CPU, which reproduces Google's result (about 145–170 ms per frame here).
- **Sound pack.** Their steering, warning and stop sounds, with their mapping: steering angle shaped with `sensitivity_curvature 0.4`, max rotation 45°, warning from 0.4 to 1.5 m off the line. The steering sound plays on the side you must turn toward. An **ear vibration** (a 48/51 Hz rumble with 24 Hz flutter) plays in that ear only, so the side to turn *vibrates*.
- **Quiet by design.** Small drifts are silent or a soft tone. Speech comes only for a big drift that lasts (over 1.2 s, at most every 6 s), and a global limiter keeps non-urgent speech at least 6 s apart with no repeats within 20 s.
- **360° perception while running.** A soft beacon sits on the line ahead. Other runners are tracked and placed around you in space (HRTF), and a runner straight ahead in your lane gets an obstacle cue.
- **Their test data, as a real-world check.** `guideline1.png` is a real waist-camera photo of their purple line on a leafy path, and comes with Google's hand-labelled mask. Choose *Real photo: Google Project Guideline test path*. EchoPath runs it through the full track pipeline and scores Google's model against Google's labels. **Measured: 100 % of keypoints on the real line, 91 % of the line found, mean error 1.4 px.** EchoPath reads 0.18 m right of the line, *steer left*, which is correct.
- What we do **not** use: their depth model (it fails on the browser GPU delegate and takes 365 ms on CPU, so Depth Anything is used instead), and their Unreal simulator (desktop C++; EchoPath has its own browser simulators). Google has not released Project Guideline's training dataset.

### Live mode: the real world, through your camera

Home → *Live, practice and real-world tests* → **Live: scan around you, then walk**. You can also say "live" in the voice menu.

- **Scan first, like Google Maps Live View.** Hold the phone at chest height, camera facing out, and turn slowly left, then right (about 9 s). EchoPath builds a 360° picture as you turn, using the gyroscope for heading:
  - where the walkable path goes;
  - what's around you (detector and depth);
  - steps and rocks (depth);
  - leaf litter (see below).

  Then it says it in short sentences with **clock positions**, the convention orientation-and-mobility instructors teach: *"Walkable path at 12 o'clock, straight ahead. Bench, 2 o'clock, about 4 metres. Leaves on the path at 11 o'clock. It may be slippery."* Guidance starts right after. Say "scan" (push-to-talk) or tap **Scan around me** to rescan.
- **Big live view.** The camera fills the panel, in its real shape (portrait phone or landscape webcam). On top are drawn the walkable path (green), leaves (orange), detected objects and the step-around arrows. Under it, a plain-text readout replaces the old black stats box.
- **Leaf litter detector** (`src/perception/ground.ts`, no ML, runs every 3rd frame). The ground is cut into cells; leaf litter is *busy* (texture above the surface you're walking on, adaptively) and *warm* (brown, orange, beige), never green. On Google's real photo it finds the leaf bank along the right edge, and flags nothing on the concrete path, the purple line, or Google's asphalt test frame. Leaves in your path get one spoken note (*"Leaves on the path ahead. Could be slippery."*), then quiet for 30 s.
- **Real photo, walk mode** runs the same scan on Google's leafy-path photo. Result: *"Walkable path at 12 o'clock, straight ahead. Nothing in the way within a few metres. Leaves along the edge of the path."*
- **Live run**: *Live: follow a painted line or track lane* opens the camera with the large live view. It uses the same pipeline as the simulator: Google's line model for purple lines, colour for others.

### Voice: everything spoken, and accurate speech-to-text

- **The voice menu** covers walk, live scan, run, practice (every simulator and the real photo), sound check and settings. After you stop, it comes back by itself.
- **Recognition accuracy:**
  - Each question only listens for its own answers. A small grammar like this is the biggest accuracy gain.
  - It checks *all* the recogniser's alternatives, not just the first.
  - Common mishearings count (*woke → walk, waste → waist, Kane → cane, paws → pause*), as do one-letter near misses of option words.
  - A guess from a hesitant recogniser is confirmed (*"Did you mean Walk? Say yes or no."*). Exact matches act at once.
  - First miss: it re-asks with the choices. Second miss: it explains the taps.
- **Live captions.** What it hears appears on screen as you speak (*Hearing: "on my waist"*), in a large high-contrast caption.
- **Push-to-talk while walking or running.** Use the **Speak a command** button, the **headphones' previous-track button** (eyes-free, works while worn), or the **V** key:
  - Walk: *what's around me, scan, pause, resume, stop, louder, quieter, calmer, more detail*.
  - Run: *stats, pause, resume, stop, louder, quieter*.
  - The microphone opens only for those few seconds. Bluetooth headsets switch to call mode while it's open, and the first use says so.

### Practice and real-world tests (one dropdown)

Home → *Practice and real-world tests*. The same dropdown is in the simulator panels, so you can switch between scenes while running.

| Scene | What it is |
|---|---|
| Walk: park path | Simulated. Lamp posts, bollards, bins, traffic cones, traffic barrels (like Project Guideline's obstacle test frame), benches along the edge, sign plates at **head height**, rocks, fallen leaves. People walk toward you (and sidestep, as people do), walk ahead slower, and cross. |
| Run: 400 m track / yellow line / purple line | Simulated courses (above). The purple line runs Google's model. |
| Real photo: Project Guideline test path | Real footage, scored against Google's labels. |
| Real video: your walking / running recording | Real footage. Record with the phone where you'll wear it, then replay it through the real pipeline. |

The **walk simulator** feeds the real walk pipeline: object detector, Depth Anything virtual cane, path model, looming, cue policy and speech. Its autopilot is a blind walker who keeps to the path by feel (shorelining the grass edge), slows as the cane tone quickens, steps aside or stops **only** when EchoPath says so, and steps back after touching something. It scores obstacles in the way, avoided, bumps, head bumps and helper assists. Project Guideline's own simulator does not support obstacles yet (their README).

- **Unrecognised obstacles** (a pole or bench the detector has no class for) are measured in 3D by depth. The step-around now steps **away from where depth measured it**, checked against the walkable path. Before this, the side came from a clutter guess, and in the simulator that sent the walker into a bench.
- **Measured** (144 m, one run, 12–13 fps): 2 obstacles in the walking line, both avoided; 0 bumps; 0 head bumps; 0 assists. Only 4 distinct spoken messages. Before the bench, reflex and depth-side fixes, a similar run had 5 bumps. Runs vary because people move randomly.

### Voice menu (eyes-free)

The app opens on a full-screen voice menu: *Tap anywhere to start.* It speaks each question, then listens ("walk", "run", "chest", "start", "louder", "turn on the cane", …). Taps always work: **tap** = choose the highlighted option, **press and hold** = next option, **double-tap** = back. If speech isn't understood: *Sorry, I didn't understand. Tap once for …*. It covers activity, phone position, course, the safety notice, a sound check ("did you hear it go around you?") and settings. The microphone is used only in the menu, never during guidance, because opening it switches Bluetooth headsets to mono.

### Bluetooth headphones on Windows laptops

- Each Bluetooth headset appears twice: *Headphones (X)* is stereo; *Headset (X Hands-Free)* is mono and cannot do spatial audio. EchoPath's Sound check says which one is playing, and warns when sound is going to the **laptop speakers** instead.
- Fix steps are built into Sound check: connect in Bluetooth settings, pick *Headphones*, and untick *Hands-free Telephony* in the device's Services if Windows keeps switching.
- **Audio buffer** is set to *Balanced* automatically on Bluetooth (stops crackle). **Keep-alive** plays an inaudible signal so the headphones don't power down the link and clip the next cue.

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
- Real-world check on Google's labelled photo: see Project Guideline above.
- 168 unit tests.

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
- **Someone ahead walking your way** (fixed, unit-tested). While you walk, a person in your path who has been tracked for at least 0.8 s and is closing slower than 0.6 m/s is no longer a STOP. You hear *"Person ahead, walking your way. Pass on the left."* once. Within 1.2 m, when you're standing still, or when someone is coming toward you, it's still a STOP. A person just seen is never assumed safe. In the latest simulator run the cue didn't trigger: no simulated walker was tracked as slowly closing for long enough. So far it's verified by tests only.
- **Walk pipeline speed** (fixed): 12–13 fps in the simulator on this laptop (detector about 50 ms). The earlier 6 fps was the simulator's own rendering cost, now cached, plus a few seconds on the slower detector model before it switches automatically.
- **Live camera, microphone and gyroscope** couldn't be exercised in the development preview browser, which blocks the camera and microphone. The scan, leaf detector and voice matching were verified on Google's real photo and with unit tests. Try *Live* on a phone.
- **Simulated imagery.** The walk and track simulators are flat-shaded renderings. The detector and depth model were trained on real photos, so the simulator understates or overstates some detections. The real-photo and real-video scenes are the check for that.

## Third-party notices

- Google Project Guideline (models, sounds, test images): Apache-2.0, © Google LLC. Downloaded at setup, not committed.
- Depth Anything V2 Small: Apache-2.0. MediaPipe EfficientDet-Lite models and tasks-vision: Apache-2.0. YOLOX-nano: Apache-2.0.
