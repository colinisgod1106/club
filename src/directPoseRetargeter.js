import * as THREE from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';

const L = {
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFoot: 31, rightFoot: 32,
};

const CHAINS = [
  [VRMHumanBoneName.RightShoulder, [L.leftShoulder, L.rightShoulder], L.rightShoulder, 0.55, 1.2, 14],
  [VRMHumanBoneName.LeftShoulder, [L.leftShoulder, L.rightShoulder], L.leftShoulder, 0.55, 1.2, 14],
  [VRMHumanBoneName.RightUpperArm, L.rightShoulder, L.rightElbow, 0.58, 1.3, 18],
  [VRMHumanBoneName.RightLowerArm, L.rightElbow, L.rightWrist, 0.62, 1.5, 20],
  [VRMHumanBoneName.LeftUpperArm, L.leftShoulder, L.leftElbow, 0.58, 1.3, 18],
  [VRMHumanBoneName.LeftLowerArm, L.leftElbow, L.leftWrist, 0.62, 1.5, 20],
  [VRMHumanBoneName.RightUpperLeg, L.rightHip, L.rightKnee, 0.58, 1.3, 16],
  [VRMHumanBoneName.RightLowerLeg, L.rightKnee, L.rightAnkle, 0.62, 1.5, 18],
  [VRMHumanBoneName.RightFoot, L.rightAnkle, L.rightFoot, 0.7, 2.5, 12],
  [VRMHumanBoneName.LeftUpperLeg, L.leftHip, L.leftKnee, 0.58, 1.3, 16],
  [VRMHumanBoneName.LeftLowerLeg, L.leftKnee, L.leftAnkle, 0.62, 1.5, 18],
  [VRMHumanBoneName.LeftFoot, L.leftAnkle, L.leftFoot, 0.7, 2.5, 12],
];

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _parentWorld = new THREE.Quaternion();
const _baseWorld = new THREE.Quaternion();
const _swing = new THREE.Quaternion();
const _targetLocal = new THREE.Quaternion();
const _neutralInverse = new THREE.Quaternion();
const _relativeEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function confidence(point) {
  return point?.visibility ?? point?.presence ?? 1;
}

function averagePoint(landmarks, indices, target) {
  const list = Array.isArray(indices) ? indices : [indices];
  target.set(0, 0, 0);
  for (const index of list) {
    const point = landmarks[index];
    if (!point) return null;
    target.x += point.x;
    target.y -= point.y;
    target.z -= point.z ?? 0;
  }
  return target.multiplyScalar(1 / list.length);
}

function reliable(landmarks, indices, threshold) {
  const list = Array.isArray(indices) ? indices : [indices];
  return list.every((index) => landmarks[index] && confidence(landmarks[index]) >= threshold);
}

function chainConfidence(landmarks, from, to) {
  const indices = [...(Array.isArray(from) ? from : [from]), ...(Array.isArray(to) ? to : [to])];
  return Math.min(...indices.map((index) => confidence(landmarks[index])));
}

export function solveLocalAimQuaternion(parentWorld, restLocal, restAxisLocal, desiredWorld) {
  _baseWorld.copy(parentWorld).multiply(restLocal);
  const baseDirection = restAxisLocal.clone().applyQuaternion(_baseWorld).normalize();
  _swing.setFromUnitVectors(baseDirection, desiredWorld.clone().normalize());
  _targetLocal.copy(parentWorld).invert().multiply(_swing).multiply(_baseWorld);
  return _targetLocal.clone().normalize();
}

export function stabilizeDirection(previous, measured, deadZoneDegrees = 1.5, maxStepDegrees = 18) {
  const next = measured.clone().normalize();
  if (!previous) return next;
  const angle = previous.angleTo(next);
  if (!Number.isFinite(angle) || angle < THREE.MathUtils.degToRad(deadZoneDegrees)) return previous.clone();
  const maxStep = THREE.MathUtils.degToRad(maxStepDegrees);
  if (angle <= maxStep) return next;
  const turn = new THREE.Quaternion().setFromUnitVectors(previous, next);
  turn.slerp(new THREE.Quaternion(), 1 - maxStep / angle);
  return previous.clone().applyQuaternion(turn).normalize();
}

function deadZone(value, radians) {
  if (Math.abs(value) <= radians) return 0;
  return value - Math.sign(value) * radians;
}

export function calibratedBodyDelta(measured, neutral, pitchScale = 0.62, rollScale = 0.72) {
  _neutralInverse.copy(neutral).invert();
  const relative = measured.clone().multiply(_neutralInverse).normalize();
  _relativeEuler.setFromQuaternion(relative, 'YXZ');
  _relativeEuler.x = deadZone(_relativeEuler.x, THREE.MathUtils.degToRad(2.5)) * pitchScale;
  _relativeEuler.z = deadZone(_relativeEuler.z, THREE.MathUtils.degToRad(2.5)) * rollScale;
  // Yaw is intentionally not damped: turning should remain one-to-one.
  return new THREE.Quaternion().setFromEuler(_relativeEuler).normalize();
}

/**
 * Retargets MediaPipe's metric 3D joints directly to the normalized VRM rig.
 * No guessed Euler angles are involved: every limb bone aims at its detected
 * child joint, then is converted back into its parent's local quaternion.
 */
export class DirectPoseRetargeter {
  constructor(vrm) {
    this.vrm = vrm;
    this.bindings = new Map();
    this.root = null;
    this.torso = [];
    this.neutralBasis = null;
    this.calibrationFrames = 0;
    this._captureRestPose();
  }

  resetCalibration() {
    this.neutralBasis = null;
    this.calibrationFrames = 0;
  }

  reset() {
    this.bindings.clear();
    this.torso = [];
    this._captureRestPose();
    this.resetCalibration();
  }

  _captureRestPose() {
    const humanoid = this.vrm.humanoid;
    humanoid.resetNormalizedPose();
    this.vrm.scene.updateMatrixWorld(true);

    for (const [boneName] of CHAINS) {
      const bone = humanoid.getNormalizedBoneNode(boneName);
      const child = this._aimChild(boneName);
      if (!bone || !child) continue;

      bone.getWorldPosition(_from);
      child.getWorldPosition(_to);
      bone.getWorldQuaternion(_baseWorld);
      const restAxisLocal = _to.sub(_from).normalize().applyQuaternion(_baseWorld.clone().invert());
      this.bindings.set(boneName, {
        bone,
        restLocal: bone.quaternion.clone(),
        restAxisLocal: restAxisLocal.clone(),
        stableDirection: null,
      });
    }

    const hips = humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
    const spine = humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine);
    const rightLeg = humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperLeg);
    const leftLeg = humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperLeg);
    if (hips && spine && rightLeg && leftLeg) {
      hips.getWorldPosition(_from);
      spine.getWorldPosition(_to);
      const up = _to.sub(_from).normalize().clone();
      rightLeg.getWorldPosition(_to);
      leftLeg.getWorldPosition(_desired);
      const right = _to.sub(_desired).normalize().clone();
      const forward = new THREE.Vector3().crossVectors(right, up).normalize();
      right.crossVectors(up, forward).normalize();
      const restBasis = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(right, up, forward),
      ).normalize();
      this.root = {
        bone: hips,
        restLocal: hips.quaternion.clone(),
        restBasis,
      };

      for (const [boneName, leanShare] of [
        [VRMHumanBoneName.Spine, 0.48],
        [VRMHumanBoneName.Chest, 0.37],
      ]) {
        const bone = humanoid.getNormalizedBoneNode(boneName);
        if (bone) this.torso.push({ bone, restLocal: bone.quaternion.clone(), leanShare });
      }
    }
  }

  _aimChild(boneName) {
    const humanoid = this.vrm.humanoid;
    const map = {
      [VRMHumanBoneName.RightShoulder]: VRMHumanBoneName.RightUpperArm,
      [VRMHumanBoneName.LeftShoulder]: VRMHumanBoneName.LeftUpperArm,
      [VRMHumanBoneName.RightUpperArm]: VRMHumanBoneName.RightLowerArm,
      [VRMHumanBoneName.RightLowerArm]: VRMHumanBoneName.RightHand,
      [VRMHumanBoneName.LeftUpperArm]: VRMHumanBoneName.LeftLowerArm,
      [VRMHumanBoneName.LeftLowerArm]: VRMHumanBoneName.LeftHand,
      [VRMHumanBoneName.RightUpperLeg]: VRMHumanBoneName.RightLowerLeg,
      [VRMHumanBoneName.RightLowerLeg]: VRMHumanBoneName.RightFoot,
      [VRMHumanBoneName.RightFoot]: VRMHumanBoneName.RightToes,
      [VRMHumanBoneName.LeftUpperLeg]: VRMHumanBoneName.LeftLowerLeg,
      [VRMHumanBoneName.LeftLowerLeg]: VRMHumanBoneName.LeftFoot,
      [VRMHumanBoneName.LeftFoot]: VRMHumanBoneName.LeftToes,
    };
    return humanoid.getNormalizedBoneNode(map[boneName]);
  }

  update(landmarks, smoothing = 0.35) {
    if (!Array.isArray(landmarks) || landmarks.length < 33) return;
    this._applyRoot(landmarks, smoothing);

    for (const [boneName, from, to, threshold, deadZoneDegrees, maxStepDegrees] of CHAINS) {
      if (!reliable(landmarks, from, threshold) || !reliable(landmarks, to, threshold)) continue;
      const binding = this.bindings.get(boneName);
      if (!binding) continue;
      averagePoint(landmarks, from, _from);
      averagePoint(landmarks, to, _to);
      _desired.subVectors(_to, _from);
      if (_desired.lengthSq() < 1e-5) continue;
      binding.stableDirection = stabilizeDirection(
        binding.stableDirection,
        _desired,
        deadZoneDegrees,
        maxStepDegrees,
      );

      const parent = binding.bone.parent;
      parent.getWorldQuaternion(_parentWorld);
      const target = solveLocalAimQuaternion(
        _parentWorld,
        binding.restLocal,
        binding.restAxisLocal,
        binding.stableDirection,
      );
      const quality = THREE.MathUtils.clamp(chainConfidence(landmarks, from, to), 0, 1);
      binding.bone.quaternion.slerp(target, smoothing * (0.55 + quality * 0.45));
      binding.bone.updateMatrixWorld(true);
    }
  }

  _applyRoot(landmarks, smoothing) {
    if (!this.root
      || !reliable(landmarks, [L.leftHip, L.rightHip, L.leftShoulder, L.rightShoulder], 0.65)) return;

    averagePoint(landmarks, [L.leftHip, L.rightHip], _from);
    averagePoint(landmarks, [L.leftShoulder, L.rightShoulder], _to);
    const up = _to.sub(_from).normalize().clone();
    averagePoint(landmarks, L.rightHip, _to);
    averagePoint(landmarks, L.leftHip, _desired);
    const right = _to.sub(_desired).normalize().clone();
    const forward = new THREE.Vector3().crossVectors(right, up).normalize();
    right.crossVectors(up, forward).normalize();
    if (forward.lengthSq() < 0.5) return;

    const measuredBasis = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, up, forward),
    ).normalize();

    // Learn the camera/person neutral stance after binding. MediaPipe world
    // depth commonly contains a persistent pitch bias; treating it as motion is
    // what made an upright person look as if they were leaning backwards.
    if (this.calibrationFrames < 12) {
      if (!this.neutralBasis) this.neutralBasis = measuredBasis.clone();
      else this.neutralBasis.slerp(measuredBasis, 1 / (this.calibrationFrames + 1));
      this.calibrationFrames++;
      return;
    }

    const delta = calibratedBodyDelta(measuredBasis, this.neutralBasis);
    const bodyEuler = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(delta, 'YXZ');
    const parent = this.root.bone.parent;
    parent.getWorldQuaternion(_parentWorld);
    const hipDelta = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      bodyEuler.x * 0.15,
      bodyEuler.y,
      bodyEuler.z * 0.15,
      'YXZ',
    ));
    const target = _parentWorld.clone().invert().multiply(hipDelta).multiply(_parentWorld).multiply(this.root.restLocal);
    this.root.bone.quaternion.slerp(target, smoothing * 0.65);
    this.root.bone.updateMatrixWorld(true);

    for (const torso of this.torso) {
      torso.bone.parent.getWorldQuaternion(_parentWorld);
      const lean = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        bodyEuler.x * torso.leanShare,
        0,
        bodyEuler.z * torso.leanShare,
        'YXZ',
      ));
      const torsoTarget = _parentWorld.clone().invert().multiply(lean).multiply(_parentWorld).multiply(torso.restLocal);
      torso.bone.quaternion.slerp(torsoTarget, smoothing * 0.72);
      torso.bone.updateMatrixWorld(true);
    }
  }
}
