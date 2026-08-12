import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LandmarkStabilizer,
  handTrackingQuality,
  hasReliableTorso,
} from '../src/poseStabilizer.js';

function torso(yaw, visibility = 1) {
  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility }));
  const x = Math.cos(yaw) * 0.2;
  const z = Math.sin(yaw) * 0.2;
  points[11] = { x, y: 0, z: -z, visibility };
  points[12] = { x: -x, y: 0, z, visibility };
  points[23] = { x: x * 0.7, y: 0.5, z: -z * 0.7, visibility };
  points[24] = { x: -x * 0.7, y: 0.5, z: z * 0.7, visibility };
  return points;
}

test('torso reliability rejects occluded anchor joints', () => {
  assert.equal(hasReliableTorso(torso(0, 0.1)), false);
  assert.equal(hasReliableTorso(torso(0, 1)), true);
});

test('landmark filter holds a low-confidence outlier', () => {
  const filter = new LandmarkStabilizer();
  filter.filter([{ x: 0, y: 0, z: 0, visibility: 1 }]);
  const [held] = filter.filter([{ x: 10, y: 10, z: 10, visibility: 0.1 }]);
  assert.deepEqual({ x: held.x, y: held.y, z: held.z }, { x: 0, y: 0, z: 0 });
});

test('hand quality rejects partial or non-finite detections', () => {
  const hand = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  assert.equal(handTrackingQuality(hand), 1);
  hand[9].z = Number.NaN;
  assert.equal(handTrackingQuality(hand), 0.8);
  assert.equal(handTrackingQuality(hand.slice(0, 10)), 0);
});
