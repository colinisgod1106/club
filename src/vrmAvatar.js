import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  LandmarkStabilizer,
  handTrackingQuality,
  hasReliableTorso,
} from './poseStabilizer.js';
import { DirectPoseRetargeter } from './directPoseRetargeter.js';

export class VRMAvatar {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.currentVrm = null;
    this.mixers = [];
    this.clock = new THREE.Clock();

    // Smoothing / LERP configuration (0 = instant, 1 = no movement)
    this.smoothingFactor = 0.55;

    // Camera defaults
    this._defaultCameraPos = new THREE.Vector3(0, 1.4, 2.5);
    this._defaultTargetPos = new THREE.Vector3(0, 1.2, 0);

    this._pose3DFilter = new LandmarkStabilizer({ minAlpha: 0.42, maxAlpha: 0.88 });
    this._bodyRetargeter = null;
    this._lastHandSeen = { Left: 0, Right: 0 };
    this._wasBound = false;

    this._initScene();
    this._initLights();
    this._initControls();
    this._animate();

    this.defaultVrmUrl = '/models/model2.vrm';
    this.loadModel(this.defaultVrmUrl);
  }

  // ─── Scene Setup ────────────────────────────────────────────────────────────

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c14);

    this.camera = new THREE.PerspectiveCamera(
      35,
      this.canvas.clientWidth / this.canvas.clientHeight,
      0.1,
      20.0
    );
    this.camera.position.copy(this._defaultCameraPos);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.gridHelper = new THREE.GridHelper(10, 20, 0x00f0ff, 0x1c2438);
    this.scene.add(this.gridHelper);

    window.addEventListener('resize', () => this.onWindowResize());
  }

  _initLights() {
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.4);
    mainLight.position.set(1.5, 3.0, 2.0);
    this.scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0x00f0ff, 0.6);
    fillLight.position.set(-2.0, 1.5, -1.0);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0x9d4edd, 0.8);
    rimLight.position.set(0.0, 2.5, -2.5);
    this.scene.add(rimLight);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this._defaultTargetPos);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.1;
    this.controls.minDistance = 1.0;
    this.controls.maxDistance = 6.0;
    this.controls.update();
  }

  // ─── Public Controls ─────────────────────────────────────────────────────────

  resetCamera() {
    this.camera.position.copy(this._defaultCameraPos);
    this.controls.target.copy(this._defaultTargetPos);
    this.controls.update();

    if (this.currentVrm) {
      this.currentVrm.scene.position.set(0, 0, 0);
      this.currentVrm.scene.rotation.set(0, 0, 0);
    }
    this._resetTrackingState();
  }

  toggleGrid() {
    this.gridHelper.visible = !this.gridHelper.visible;
  }

  // ─── Model Loading ───────────────────────────────────────────────────────────

  loadModel(urlOrFile) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const loadingUrl = typeof urlOrFile === 'string'
      ? urlOrFile
      : URL.createObjectURL(urlOrFile);

    loader.load(
      loadingUrl,
      (gltf) => {
        const vrm = gltf.userData.vrm;
        if (!vrm) return;

        if (this.currentVrm) {
          this.scene.remove(this.currentVrm.scene);
          VRMUtils.deepDispose(this.currentVrm.scene);
        }

        this.currentVrm = vrm;
        this.scene.add(vrm.scene);
        VRMUtils.rotateVRM0(vrm);
        vrm.scene.position.set(0, 0, 0);

        this._bodyRetargeter = null;
        this._resetTrackingState();
        this._bodyRetargeter = new DirectPoseRetargeter(vrm);
        this.controls.target.copy(this._defaultTargetPos);
        this.controls.update();

        console.log('[VRM] Model loaded. Humanoid bones:', Object.keys(vrm.humanoid.humanBones));
      },
      (progress) => {
        console.log(`[VRM] Loading: ${((progress.loaded / progress.total) * 100).toFixed(1)}%`);
      },
      (error) => {
        console.warn('[VRM] Load failed, using fallback avatar:', error);
        this._createFallbackAvatar();
      }
    );
  }

  _createFallbackAvatar() {
    if (this.currentVrm) this.scene.remove(this.currentVrm.scene);
    const group = new THREE.Group();
    const mat = new THREE.MeshToonMaterial({ color: 0x00f0ff });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), mat);
    head.position.set(0, 1.5, 0);
    group.add(head);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.5), mat);
    torso.position.set(0, 1.1, 0);
    group.add(torso);
    this.scene.add(group);
  }

  // ─── Motion Update Entry Point ───────────────────────────────────────────────

  /**
   * Called every MediaPipe frame with holistic results.
   * @param {object} results - MediaPipe Holistic results
   * @param {boolean} isBound - Whether pose mirroring is active
   * @param {HTMLVideoElement} videoEl - The video element (needed for Kalidokit aspect ratio)
   */
  updateMotion(results, isBound, videoEl) {
    if (!this.currentVrm || !isBound) {
      this._wasBound = false;
      return;
    }

    if (!this._wasBound) {
      this._pose3DFilter.reset();
      this._bodyRetargeter?.reset();
      this._wasBound = true;
    }

    const rawPoseLandmarks = results.poseLandmarks;
    // poseWorldLandmarks gives metric 3-D coords; fall back gracefully
    const rawPose3DLandmarks = results.poseWorldLandmarks
                            || results.ea
                            || rawPoseLandmarks;
    const rightHandLandmarks = results.rightHandLandmarks;
    const leftHandLandmarks  = results.leftHandLandmarks;
    const faceLandmarks      = results.faceLandmarks;

    if (!rawPoseLandmarks || !hasReliableTorso(rawPoseLandmarks)) return;

    const pose3DLandmarks = this._pose3DFilter.filter(rawPose3DLandmarks);

    // Body motion is solved directly from metric 3D joint directions. Kalidokit
    // remains only for face/finger detail; its approximate body Euler solver is
    // deliberately bypassed.
    this._bodyRetargeter?.update(pose3DLandmarks, 1 - this.smoothingFactor * 0.48);

    const Kali = window.Kalidokit;
    if (!Kali) return;

    // ── Solve Face ────────────────────────────────────────────────────────────
    if (faceLandmarks) {
      const riggedFace = Kali.Face.solve(faceLandmarks, {
        runtime: 'mediapipe',
        video: videoEl || null,
      });
      if (riggedFace) this._applyRiggedFace(riggedFace);
    }

    // ── Solve Hands ───────────────────────────────────────────────────────────
    const now = performance.now();
    if (handTrackingQuality(rightHandLandmarks) >= 1) {
      const riggedRightHand = Kali.Hand.solve(rightHandLandmarks, 'Right');
      if (riggedRightHand) {
        this._applyRiggedHand(riggedRightHand, 'Right');
        this._lastHandSeen.Right = now;
      }
    }
    if (handTrackingQuality(leftHandLandmarks) >= 1) {
      const riggedLeftHand = Kali.Hand.solve(leftHandLandmarks, 'Left');
      if (riggedLeftHand) {
        this._applyRiggedHand(riggedLeftHand, 'Left');
        this._lastHandSeen.Left = now;
      }
    }

    this._relaxMissingHand('Right', now);
    this._relaxMissingHand('Left', now);
  }

  // ─── Internal Helpers ────────────────────────────────────────────────────────

  /**
   * Apply an Euler rotation (from Kalidokit) to a VRM bone with smoothing.
   * @param {string} boneName  - VRMHumanBoneName constant
   * @param {object} rot       - { x, y, z } in radians
   * @param {number} dampener  - Scale factor applied to all axes (default 1)
   * @param {number} lerpAmt   - Per-frame lerp weight (default = 1 - smoothingFactor)
   */
  _rigRotation(boneName, rot, dampener = 1, lerpAmt = null) {
    if (!rot) return;
    const vrm = this.currentVrm;
    if (!vrm || !vrm.humanoid) return;

    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;

    const t = lerpAmt !== null ? lerpAmt : (1 - this.smoothingFactor);

    const euler = new THREE.Euler(
      rot.x * dampener,
      rot.y * dampener,
      rot.z * dampener,
      'XYZ'
    );
    const q = new THREE.Quaternion().setFromEuler(euler);
    node.quaternion.slerp(q, t);
  }

  // ─── Face Application ────────────────────────────────────────────────────────

  _applyRiggedFace(riggedFace) {
    const vrm = this.currentVrm;
    if (!vrm || !vrm.humanoid) return;

    const L = 1 - this.smoothingFactor;

    if (riggedFace.head) {
      this._rigRotation(VRMHumanBoneName.Neck, riggedFace.head, 0.35, L);
      this._rigRotation(VRMHumanBoneName.Head, riggedFace.head, 0.65, L);
    }

    if (riggedFace.eye && vrm.expressionManager) {
      vrm.expressionManager.setValue('blinkLeft', 1 - riggedFace.eye.l);
      vrm.expressionManager.setValue('blinkRight', 1 - riggedFace.eye.r);
    }
  }

  // ─── Hand Application ────────────────────────────────────────────────────────

  _applyRiggedHand(riggedHand, side) {
    const vrm = this.currentVrm;
    if (!vrm || !vrm.humanoid) return;

    const L = 1 - this.smoothingFactor;
    const p = side; // 'Right' or 'Left'

    // Wrist
    this._rigRotation(
      side === 'Right' ? VRMHumanBoneName.RightHand : VRMHumanBoneName.LeftHand,
      riggedHand[`${p}Wrist`], 1, L
    );

    // Fingers — index, middle, ring, pinky + thumb
    const fingerMap = [
      { kali: `${p}RingProximal`,      vrm: side === 'Right' ? VRMHumanBoneName.RightRingProximal      : VRMHumanBoneName.LeftRingProximal      },
      { kali: `${p}RingIntermediate`,  vrm: side === 'Right' ? VRMHumanBoneName.RightRingIntermediate  : VRMHumanBoneName.LeftRingIntermediate  },
      { kali: `${p}RingDistal`,        vrm: side === 'Right' ? VRMHumanBoneName.RightRingDistal        : VRMHumanBoneName.LeftRingDistal        },
      { kali: `${p}IndexProximal`,     vrm: side === 'Right' ? VRMHumanBoneName.RightIndexProximal     : VRMHumanBoneName.LeftIndexProximal     },
      { kali: `${p}IndexIntermediate`, vrm: side === 'Right' ? VRMHumanBoneName.RightIndexIntermediate : VRMHumanBoneName.LeftIndexIntermediate },
      { kali: `${p}IndexDistal`,       vrm: side === 'Right' ? VRMHumanBoneName.RightIndexDistal       : VRMHumanBoneName.LeftIndexDistal       },
      { kali: `${p}MiddleProximal`,    vrm: side === 'Right' ? VRMHumanBoneName.RightMiddleProximal    : VRMHumanBoneName.LeftMiddleProximal    },
      { kali: `${p}MiddleIntermediate`,vrm: side === 'Right' ? VRMHumanBoneName.RightMiddleIntermediate: VRMHumanBoneName.LeftMiddleIntermediate},
      { kali: `${p}MiddleDistal`,      vrm: side === 'Right' ? VRMHumanBoneName.RightMiddleDistal      : VRMHumanBoneName.LeftMiddleDistal      },
      { kali: `${p}ThumbProximal`,     vrm: side === 'Right' ? VRMHumanBoneName.RightThumbMetacarpal   : VRMHumanBoneName.LeftThumbMetacarpal   },
      { kali: `${p}ThumbIntermediate`, vrm: side === 'Right' ? VRMHumanBoneName.RightThumbProximal     : VRMHumanBoneName.LeftThumbProximal     },
      { kali: `${p}ThumbDistal`,       vrm: side === 'Right' ? VRMHumanBoneName.RightThumbDistal       : VRMHumanBoneName.LeftThumbDistal       },
      { kali: `${p}LittleProximal`,    vrm: side === 'Right' ? VRMHumanBoneName.RightLittleProximal    : VRMHumanBoneName.LeftLittleProximal    },
      { kali: `${p}LittleIntermediate`,vrm: side === 'Right' ? VRMHumanBoneName.RightLittleIntermediate: VRMHumanBoneName.LeftLittleIntermediate},
      { kali: `${p}LittleDistal`,      vrm: side === 'Right' ? VRMHumanBoneName.RightLittleDistal      : VRMHumanBoneName.LeftLittleDistal      },
    ];

    for (const { kali, vrm: boneName } of fingerMap) {
      if (riggedHand[kali]) {
        this._rigRotation(boneName, riggedHand[kali], 1, L);
      }
    }
  }

  _relaxMissingHand(side, now) {
    if (now - this._lastHandSeen[side] < 240) return;

    const fingers = ['Index', 'Middle', 'Ring', 'Little'];
    const joints = ['Proximal', 'Intermediate', 'Distal'];
    for (const finger of fingers) {
      for (const joint of joints) {
        const boneName = VRMHumanBoneName[`${side}${finger}${joint}`];
        if (boneName) this._rigRotation(boneName, { x: 0, y: 0, z: 0 }, 1, 0.12);
      }
    }

    for (const joint of ['Metacarpal', 'Proximal', 'Distal']) {
      this._rigRotation(
        VRMHumanBoneName[`${side}Thumb${joint}`],
        { x: 0, y: 0, z: 0 },
        1,
        0.12,
      );
    }
  }

  _resetTrackingState() {
    this._pose3DFilter.reset();
    this._bodyRetargeter?.reset();
    this._lastHandSeen.Left = 0;
    this._lastHandSeen.Right = 0;
    this._wasBound = false;
  }

  // ─── Resize & Render Loop ────────────────────────────────────────────────────

  onWindowResize() {
    const width  = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());

    const delta = this.clock.getDelta();
    if (this.currentVrm) this.currentVrm.update(delta);

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
