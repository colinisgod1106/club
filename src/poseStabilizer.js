const POSE_TORSO = [11, 12, 23, 24];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function landmarkConfidence(landmark) {
  return landmark?.visibility ?? landmark?.presence ?? 1;
}

export class LandmarkStabilizer {
  constructor({ minConfidence = 0.45, minAlpha = 0.18, maxAlpha = 0.72 } = {}) {
    this.minConfidence = minConfidence;
    this.minAlpha = minAlpha;
    this.maxAlpha = maxAlpha;
    this.previous = [];
  }

  reset() {
    this.previous = [];
  }

  filter(landmarks) {
    if (!Array.isArray(landmarks)) return null;
    const filtered = landmarks.map((point, index) => {
      const previous = this.previous[index];
      if (!point) return previous ? { ...previous } : point;
      const confidence = landmarkConfidence(point);
      if (previous && confidence < this.minConfidence) {
        return { ...previous, visibility: confidence, presence: point.presence };
      }
      if (!previous) return { ...point };

      const velocity = Math.hypot(
        point.x - previous.x,
        point.y - previous.y,
        (point.z ?? 0) - (previous.z ?? 0),
      );
      const alpha = clamp(this.minAlpha + velocity * 5, this.minAlpha, this.maxAlpha);
      return {
        ...point,
        x: previous.x + (point.x - previous.x) * alpha,
        y: previous.y + (point.y - previous.y) * alpha,
        z: (previous.z ?? 0) + ((point.z ?? 0) - (previous.z ?? 0)) * alpha,
      };
    });
    this.previous = filtered.map((point) => point && ({ ...point }));
    return filtered;
  }
}

export class TorsoOrientationTracker {
  constructor({ alpha = 0.28, maxStep = Math.PI / 10, minConfidence = 0.55 } = {}) {
    this.alpha = alpha;
    this.maxStep = maxStep;
    this.minConfidence = minConfidence;
    this.yaw = null;
  }

  reset() {
    this.yaw = null;
  }

  update(worldLandmarks) {
    if (!hasReliableTorso(worldLandmarks, this.minConfidence)) return this.yaw;
    const ls = worldLandmarks[11];
    const rs = worldLandmarks[12];
    const lh = worldLandmarks[23];
    const rh = worldLandmarks[24];
    const dx = ((rs.x - ls.x) * 0.7) + ((rh.x - lh.x) * 0.3);
    const dz = (((rs.z ?? 0) - (ls.z ?? 0)) * 0.7)
      + (((rh.z ?? 0) - (lh.z ?? 0)) * 0.3);
    if (Math.hypot(dx, dz) < 0.08) return this.yaw;

    const measured = Math.atan2(dz, -dx);
    if (this.yaw === null) {
      this.yaw = measured;
      return this.yaw;
    }
    const delta = Math.atan2(Math.sin(measured - this.yaw), Math.cos(measured - this.yaw));
    this.yaw += clamp(delta, -this.maxStep, this.maxStep) * this.alpha;
    return this.yaw;
  }
}

export function hasReliableTorso(landmarks, minConfidence = 0.45) {
  return Array.isArray(landmarks)
    && POSE_TORSO.every((index) => landmarks[index]
      && landmarkConfidence(landmarks[index]) >= minConfidence);
}

export function handTrackingQuality(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return 0;
  const palm = [0, 5, 9, 13, 17];
  return palm.filter((index) => {
    const point = landmarks[index];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
  }).length / palm.length;
}
