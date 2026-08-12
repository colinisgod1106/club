const POSE_TORSO = [11, 12, 23, 24];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function landmarkConfidence(landmark) {
  return landmark?.visibility ?? landmark?.presence ?? 1;
}

export class LandmarkStabilizer {
  constructor({ minConfidence = 0.45, minAlpha = 0.32, maxAlpha = 0.82 } = {}) {
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
