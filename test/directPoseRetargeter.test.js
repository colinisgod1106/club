import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VRMHumanBoneName as B } from '@pixiv/three-vrm';
import {
  DirectPoseRetargeter,
  calibratedBodyDelta,
  solveLocalAimQuaternion,
  stabilizeDirection,
} from '../src/directPoseRetargeter.js';

const EPSILON = 1e-6;

test('aim solver aligns a bone in world space under a rotated parent', () => {
  const parentWorld = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0.25, 0.8, -0.15),
  );
  const restLocal = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-0.1, 0.2, 0.05),
  );
  const restAxis = new THREE.Vector3(0, -1, 0);
  const desired = new THREE.Vector3(0.7, -0.2, 0.6).normalize();

  const solvedLocal = solveLocalAimQuaternion(parentWorld, restLocal, restAxis, desired);
  const actual = restAxis.clone().applyQuaternion(
    parentWorld.clone().multiply(solvedLocal),
  ).normalize();

  assert.ok(actual.distanceTo(desired) < EPSILON);
});

test('aim solver produces finite normalized quaternions for opposite directions', () => {
  const solved = solveLocalAimQuaternion(
    new THREE.Quaternion(),
    new THREE.Quaternion(),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
  );

  assert.ok([...solved.toArray()].every(Number.isFinite));
  assert.ok(Math.abs(solved.length() - 1) < EPSILON);
});

test('neutral calibration removes persistent camera pitch bias', () => {
  const cameraBias = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(-18), 0, 0, 'YXZ'),
  );
  const corrected = calibratedBodyDelta(cameraBias, cameraBias);
  assert.ok(corrected.angleTo(new THREE.Quaternion()) < EPSILON);
});

test('calibration keeps yaw one-to-one while softening torso lean', () => {
  const neutral = new THREE.Quaternion();
  const measured = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(20), THREE.MathUtils.degToRad(45), 0, 'YXZ'),
  );
  const correctedEuler = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(
    calibratedBodyDelta(measured, neutral),
    'YXZ',
  );

  assert.ok(Math.abs(THREE.MathUtils.radToDeg(correctedEuler.y) - 45) < 0.01);
  assert.ok(THREE.MathUtils.radToDeg(correctedEuler.x) < 12);
  assert.ok(THREE.MathUtils.radToDeg(correctedEuler.x) > 9);
});

test('direction stabilizer rejects sub-degree depth jitter', () => {
  const stable = new THREE.Vector3(1, 0, 0);
  const noisy = new THREE.Vector3(1, 0.004, -0.006).normalize();
  const result = stabilizeDirection(stable, noisy, 1.5, 18);
  assert.ok(result.distanceTo(stable) < EPSILON);
});

test('direction stabilizer caps one-frame tracking spikes', () => {
  const stable = new THREE.Vector3(1, 0, 0);
  const spike = new THREE.Vector3(0, 1, 0);
  const result = stabilizeDirection(stable, spike, 1.5, 18);
  assert.ok(Math.abs(THREE.MathUtils.radToDeg(stable.angleTo(result)) - 18) < 0.01);
});

function makeNode(parent, position) {
  const node = new THREE.Object3D();
  node.position.fromArray(position);
  parent.add(node);
  return node;
}

function fakeVrm() {
  const scene = new THREE.Object3D();
  const bones = {};
  bones[B.Hips] = makeNode(scene, [0, 1, 0]);
  bones[B.Spine] = makeNode(bones[B.Hips], [0, 0.25, 0]);
  bones[B.Chest] = makeNode(bones[B.Spine], [0, 0.25, 0]);

  for (const side of ['Right', 'Left']) {
    const sign = side === 'Right' ? -1 : 1;
    bones[B[`${side}UpperArm`]] = makeNode(bones[B.Chest], [sign * 0.2, 0.15, 0]);
    bones[B[`${side}LowerArm`]] = makeNode(bones[B[`${side}UpperArm`]], [sign * 0.3, 0, 0]);
    bones[B[`${side}Hand`]] = makeNode(bones[B[`${side}LowerArm`]], [sign * 0.3, 0, 0]);
    bones[B[`${side}UpperLeg`]] = makeNode(bones[B.Hips], [sign * 0.1, -0.05, 0]);
    bones[B[`${side}LowerLeg`]] = makeNode(bones[B[`${side}UpperLeg`]], [0, -0.45, 0]);
    bones[B[`${side}Foot`]] = makeNode(bones[B[`${side}LowerLeg`]], [0, -0.45, 0]);
    bones[B[`${side}Toes`]] = makeNode(bones[B[`${side}Foot`]], [0, -0.05, 0.15]);
  }

  return {
    scene,
    humanoid: {
      getNormalizedBoneNode: (name) => bones[name] ?? null,
      resetNormalizedPose: () => scene.traverse((node) => node.quaternion.identity()),
    },
    bones,
  };
}

function syntheticPose() {
  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  Object.assign(points[11], { x: 0.2, y: -0.5 });
  Object.assign(points[12], { x: -0.2, y: -0.5 });
  Object.assign(points[13], { x: 0.55, y: -0.8 });
  Object.assign(points[14], { x: -0.55, y: -0.8 });
  Object.assign(points[15], { x: 0.75, y: -0.55 });
  Object.assign(points[16], { x: -0.75, y: -0.55 });
  Object.assign(points[23], { x: 0.1, y: 0 });
  Object.assign(points[24], { x: -0.1, y: 0 });
  Object.assign(points[25], { x: 0.15, y: 0.5 });
  Object.assign(points[26], { x: -0.15, y: 0.5 });
  Object.assign(points[27], { x: 0.3, y: 0.95 });
  Object.assign(points[28], { x: -0.3, y: 0.95 });
  Object.assign(points[29], { x: 0.3, y: 1 });
  Object.assign(points[30], { x: -0.3, y: 1 });
  Object.assign(points[31], { x: 0.3, y: 1, z: -0.2 });
  Object.assign(points[32], { x: -0.3, y: 1, z: -0.2 });
  return points;
}

test('full chain retargeter aims arms and legs at detected child joints', () => {
  const vrm = fakeVrm();
  const retargeter = new DirectPoseRetargeter(vrm);
  const pose = syntheticPose();
  retargeter.update(pose, 1);
  vrm.scene.updateMatrixWorld(true);

  for (const [boneName, childName, from, to] of [
    [B.RightUpperArm, B.RightLowerArm, 12, 14],
    [B.RightLowerArm, B.RightHand, 14, 16],
    [B.LeftUpperLeg, B.LeftLowerLeg, 23, 25],
    [B.RightLowerLeg, B.RightFoot, 26, 28],
  ]) {
    const actual = vrm.bones[childName].getWorldPosition(new THREE.Vector3())
      .sub(vrm.bones[boneName].getWorldPosition(new THREE.Vector3())).normalize();
    const desired = new THREE.Vector3(
      pose[to].x - pose[from].x,
      -(pose[to].y - pose[from].y),
      -(pose[to].z - pose[from].z),
    ).normalize();
    assert.ok(actual.distanceTo(desired) < EPSILON, `${boneName} did not reach its detected direction`);
  }
});

test('calibrated torso motion is distributed through hips, spine and chest', () => {
  const vrm = fakeVrm();
  const retargeter = new DirectPoseRetargeter(vrm);
  const neutral = syntheticPose();
  for (let frame = 0; frame < 12; frame++) retargeter.update(neutral, 1);

  const leaning = syntheticPose();
  leaning[11].z = -0.25;
  leaning[12].z = -0.25;
  retargeter.update(leaning, 1);

  assert.ok(vrm.bones[B.Hips].quaternion.angleTo(new THREE.Quaternion()) > 0.005);
  assert.ok(vrm.bones[B.Spine].quaternion.angleTo(new THREE.Quaternion()) > 0.005);
  assert.ok(vrm.bones[B.Chest].quaternion.angleTo(new THREE.Quaternion()) > 0.005);
});
