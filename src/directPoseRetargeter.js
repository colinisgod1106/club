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
  [VRMHumanBoneName.Spine, [L.leftHip, L.rightHip], [L.leftShoulder, L.rightShoulder], 0.5],
  [VRMHumanBoneName.RightUpperArm, L.rightShoulder, L.rightElbow, 0.75],
  [VRMHumanBoneName.RightLowerArm, L.rightElbow, L.rightWrist, 0.82],
  [VRMHumanBoneName.LeftUpperArm, L.leftShoulder, L.leftElbow, 0.75],
  [VRMHumanBoneName.LeftLowerArm, L.leftElbow, L.leftWrist, 0.82],
  [VRMHumanBoneName.RightUpperLeg, L.rightHip, L.rightKnee, 0.68],
  [VRMHumanBoneName.RightLowerLeg, L.rightKnee, L.rightAnkle, 0.78],
  [VRMHumanBoneName.RightFoot, L.rightAnkle, L.rightFoot, 0.7],
  [VRMHumanBoneName.LeftUpperLeg, L.leftHip, L.leftKnee, 0.68],
  [VRMHumanBoneName.LeftLowerLeg, L.leftKnee, L.leftAnkle, 0.78],
  [VRMHumanBoneName.LeftFoot, L.leftAnkle, L.leftFoot, 0.7],
];

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _parentWorld = new THREE.Quaternion();
const _baseWorld = new THREE.Quaternion();
const _swing = new THREE.Quaternion();
const _targetLocal = new THREE.Quaternion();

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

export function solveLocalAimQuaternion(parentWorld, restLocal, restAxisLocal, desiredWorld) {
  _baseWorld.copy(parentWorld).multiply(restLocal);
  const baseDirection = restAxisLocal.clone().applyQuaternion(_baseWorld).normalize();
  _swing.setFromUnitVectors(baseDirection, desiredWorld.clone().normalize());
  _targetLocal.copy(parentWorld).invert().multiply(_swing).multiply(_baseWorld);
  return _targetLocal.clone().normalize();
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
    this._captureRestPose();
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
      });
    }

    const hips = humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
    const spine = humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine);
    const rightLeg = humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperLeg);
    const leftLeg = humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperLeg);
    if (hips && spine && rightLeg && leftLeg) {
      hips.getWorldPosition(_from);
      spine.getWorldPosition(_to);
      const up = _to.sub(_from).normalize();
      rightLeg.getWorldPosition(_to);
      leftLeg.getWorldPosition(_desired);
      const right = _to.sub(_desired).normalize();
      const forward = new THREE.Vector3().crossVectors(up, right).normalize();
      const restBasis = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(right, up, forward),
      );
      this.root = {
        bone: hips,
        restLocal: hips.quaternion.clone(),
        restBasis,
      };
    }
  }

  _aimChild(boneName) {
    const humanoid = this.vrm.humanoid;
    const map = {
      [VRMHumanBoneName.Spine]: VRMHumanBoneName.Chest,
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

    for (const [boneName, from, to, threshold] of CHAINS) {
      if (!reliable(landmarks, from, threshold) || !reliable(landmarks, to, threshold)) continue;
      const binding = this.bindings.get(boneName);
      if (!binding) continue;
      averagePoint(landmarks, from, _from);
      averagePoint(landmarks, to, _to);
      _desired.subVectors(_to, _from);
      if (_desired.lengthSq() < 1e-5) continue;

      const parent = binding.bone.parent;
      parent.getWorldQuaternion(_parentWorld);
      const target = solveLocalAimQuaternion(
        _parentWorld,
        binding.restLocal,
        binding.restAxisLocal,
        _desired,
      );
      binding.bone.quaternion.slerp(target, smoothing);
      binding.bone.updateMatrixWorld(true);
    }
  }

  _applyRoot(landmarks, smoothing) {
    if (!this.root
      || !reliable(landmarks, [L.leftHip, L.rightHip, L.leftShoulder, L.rightShoulder], 0.65)) return;

    averagePoint(landmarks, [L.leftHip, L.rightHip], _from);
    averagePoint(landmarks, [L.leftShoulder, L.rightShoulder], _to);
    const up = _to.sub(_from).normalize();
    averagePoint(landmarks, L.rightHip, _to);
    averagePoint(landmarks, L.leftHip, _desired);
    const right = _to.sub(_desired).normalize();
    const forward = new THREE.Vector3().crossVectors(up, right).normalize();
    right.crossVectors(forward, up).normalize();
    if (forward.lengthSq() < 0.5) return;

    const measuredBasis = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, up, forward),
    );
    const delta = measuredBasis.multiply(this.root.restBasis.clone().invert());
    const parent = this.root.bone.parent;
    parent.getWorldQuaternion(_parentWorld);
    const target = _parentWorld.clone().invert().multiply(delta).multiply(_parentWorld).multiply(this.root.restLocal);
    this.root.bone.quaternion.slerp(target, smoothing * 0.65);
    this.root.bone.updateMatrixWorld(true);
  }
}
