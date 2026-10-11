/**
 * Simulated courses for practising and demonstrating track mode, in real
 * metres. World plane: X east, Y north, headings in radians from +X,
 * counter-clockwise.
 *
 *  - 'stadium': a standard 400 m athletics track (World Athletics geometry:
 *    84.39 m straights, 36.5 m inner radius, eight 1.22 m lanes, 5 cm white
 *    lines on a red surface, grass infield). Runs counter-clockwise.
 *  - 'road': a road with a painted yellow guide line (Project Guideline-style)
 *    that bends gently left and right, white kerb lines 3 m either side.
 */
export type CourseId = 'stadium' | 'road' | 'purple';

export const LANE_W = 1.22;
export const LINE_W = 0.05;
const STRAIGHT = 84.39;
const R0 = 36.5;
const HALF = STRAIGHT / 2;

export type Paint = 'white' | 'yellow' | 'purple' | 'track' | 'road' | 'grass';

export interface Course {
  id: CourseId;
  /** Lane the runner uses (stadium). */
  lane: number;
  /** What's painted at a world point. */
  paintAt(x: number, y: number): Paint;
  /** Ground-truth lateral offset from the line/lane centre (m, + = to the runner's right). */
  lateral(x: number, y: number): number;
  /** Direction of travel along the course at a point (rad). */
  tangent(x: number, y: number): number;
  /** Start pose. */
  start(): { x: number; y: number; heading: number };
}

/** Distance from the stadium's "spine" (the straight segment between the two bend centres). */
function stadiumRadius(x: number, y: number): number {
  if (Math.abs(x) <= HALF) return Math.abs(y);
  return Math.hypot(Math.abs(x) - HALF, y);
}

export function stadium(lane = 3): Course {
  const centreR = R0 + (lane - 0.5) * LANE_W;
  return {
    id: 'stadium',
    lane,
    paintAt(x, y) {
      const r = stadiumRadius(x, y);
      if (r < R0 - LINE_W) return 'grass';
      if (r > R0 + 8 * LANE_W + 1.5) return 'grass';
      const k = (r - R0) / LANE_W;
      const nearest = Math.round(k);
      if (nearest >= 0 && nearest <= 8 && Math.abs(r - (R0 + nearest * LANE_W)) < LINE_W / 2) return 'white';
      return 'track';
    },
    // Counter-clockwise: the infield is on your LEFT, so further out = to your right.
    lateral(x, y) {
      return stadiumRadius(x, y) - centreR;
    },
    tangent(x, y) {
      if (Math.abs(x) <= HALF) return y < 0 ? 0 : Math.PI;
      const cx = x > 0 ? HALF : -HALF;
      return Math.atan2(y, x - cx) + Math.PI / 2;
    },
    start() {
      return { x: -20, y: -centreR, heading: 0 };
    },
  };
}

const ROAD_A = 6;
const ROAD_L = 70;
export const roadLineY = (x: number) => ROAD_A * Math.sin((2 * Math.PI * x) / ROAD_L);
const roadSlope = (x: number) => ROAD_A * ((2 * Math.PI) / ROAD_L) * Math.cos((2 * Math.PI * x) / ROAD_L);

/** `guide`: paint of the guide line (yellow racing line, or Project Guideline's purple). */
export function road(guide: 'yellow' | 'purple' = 'yellow'): Course {
  return {
    id: 'road',
    lane: 0,
    paintAt(x, y) {
      // Perpendicular-ish distance to the guide line (good for gentle bends).
      const d = (y - roadLineY(x)) / Math.sqrt(1 + roadSlope(x) ** 2);
      if (Math.abs(d) < 0.06) return guide; // 12 cm painted line
      if (Math.abs(Math.abs(d) - 3) < 0.05) return 'white';
      if (Math.abs(d) > 3.6) return 'grass';
      return 'road';
    },
    // Heading +X, +Y is to your LEFT, so right-of-line = negative d.
    lateral(x, y) {
      return -(y - roadLineY(x)) / Math.sqrt(1 + roadSlope(x) ** 2);
    },
    tangent(x) {
      return Math.atan(roadSlope(x));
    },
    start() {
      return { x: 0, y: roadLineY(0), heading: Math.atan(roadSlope(0)) };
    },
  };
}

export interface RunnerState {
  x: number;
  y: number;
  heading: number;
  /** m/s */
  speed: number;
  /** Turn rate, rad/s (+ = left/counter-clockwise in world terms). */
  turnRate: number;
  /** Distance covered (m). */
  distance: number;
}

/**
 * One step of runner motion. `steer` is the runner's own steering command in
 * rad/s, + = to their RIGHT (clockwise).
 */
export function stepRunner(r: RunnerState, steer: number, dt: number): RunnerState {
  const turnRate = -steer;
  const heading = r.heading + turnRate * dt;
  const d = r.speed * dt;
  return {
    x: r.x + Math.cos(heading) * d,
    y: r.y + Math.sin(heading) * d,
    heading,
    speed: r.speed,
    turnRate,
    distance: r.distance + d,
  };
}

/** Wrap an angle to (-pi, pi]. */
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
