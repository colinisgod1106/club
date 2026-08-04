import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';

export class VRMAvatar {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.currentVrm = null;
    this.mixers = [];
    this.clock = new THREE.Clock();

    // Smoothing / LERP configuration (0 = instant, 1 = no movement)
    this.smoothingFactor = 0.7;

    // Camera defaults
    this._defaultCameraPos = new THREE.Vector3(0, 1.4, 2.5);
    this._defaultTargetPos = new THREE.Vector3(0, 1.2, 0);

    // Anti-flip: track previous Hips quaternion to detect sudden jumps
    this._prevHipsQuat = new THREE.Quaternion();

    // Debug: print first rigged pose result
    this._debugFrames = 0;

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
    // Reset anti-flip tracker
    this._prevHipsQuat.identity();
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

        this._prevHipsQuat.identity();
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
    if (!this.currentVrm || !isBound) return;

    const poseLandmarks    = results.poseLandmarks;
    // poseWorldLandmarks gives metric 3-D coords; fall back gracefully
    const pose3DLandmarks  = results.ea
                          || results.poseWorldLandmarks
                          || poseLandmarks;
    const rightHandLandmarks = results.rightHandLandmarks;
    const leftHandLandmarks  = results.leftHandLandmarks;
    const faceLandmarks      = results.faceLandmarks;

    if (!poseLandmarks) return;

    const Kali = window.Kalidokit;
    if (!Kali) { console.warn('[VRM] Kalidokit not loaded'); return; }

    // ── Solve Pose ────────────────────────────────────────────────────────────
    const riggedPose = Kali.Pose.solve(pose3DLandmarks, poseLandmarks, {
      runtime: 'mediapipe',
      video: videoEl || null,   // Pass video element for correct aspect ratio
      enableLegs: true,
    });

    // ── Debug: log first result so we can see actual keys ─────────────────────
    if (this._debugFrames < 3 && riggedPose) {
      console.log('[Kalidokit] riggedPose sample:', JSON.stringify(riggedPose, null, 2));
      this._debugFrames++;
    }

    if (riggedPose) this._applyRiggedPose(riggedPose);

    // ── Solve Face ────────────────────────────────────────────────────────────
    if (faceLandmarks) {
      const riggedFace = Kali.Face.solve(faceLandmarks, {
        runtime: 'mediapipe',
        video: videoEl || null,
      });
      if (riggedFace) this._applyRiggedFace(riggedFace);
    }

    // ── Solve Hands ───────────────────────────────────────────────────────────
    if (rightHandLandmarks) {
      const riggedRightHand = Kali.Hand.solve(rightHandLandmarks, 'Right');
      if (riggedRightHand) this._applyRiggedHand(riggedRightHand, 'Right');
    }
    if (leftHandLandmarks) {
      const riggedLeftHand = Kali.Hand.solve(leftHandLandmarks, 'Left');
      if (riggedLeftHand) this._applyRiggedHand(riggedLeftHand, 'Left');
    }
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

  /**
   * Move a VRM bone's position (used for Hips translation → walking).
   */
  _rigPosition(boneName, pos, dampener = 1, lerpAmt = null) {
    if (!pos) return;
    const vrm = this.currentVrm;
    if (!vrm || !vrm.humanoid) return;

    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;

    const t = lerpAmt !== null ? lerpAmt : (1 - this.smoothingFactor);

    const v = new THREE.Vector3(
      pos.x * dampener,
      pos.y * dampener,
      pos.z * dampener
    );
    node.position.lerp(v, t);
  }

  // ─── Pose Application ────────────────────────────────────────────────────────

  _applyRiggedPose(riggedPose) {
    const vrm = this.currentVrm;
    if (!vrm || !vrm.humanoid) return;

    const L = 1 - this.smoothingFactor; // lerp weight per frame

    // ── Hips ─────────────────────────────────────────────────────────────────
    if (riggedPose.Hips) {
      const hipsRot = riggedPose.Hips.rotation || riggedPose.Hips;
      const hipsNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);

      if (hipsNode && hipsRot) {
        const targetQ = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(hipsRot.x, hipsRot.y, hipsRot.z, 'XYZ')
        );

        // Anti-flip: if the quaternion jumps by >150° in one frame, it's a
        // tracking artefact (e.g. when you spin). Skip that frame so the
        // torso doesn't suddenly flip 180°.
        const angleDelta = this._prevHipsQuat.angleTo(targetQ);
        if (angleDelta < Math.PI * 0.85) {
          hipsNode.quaternion.slerp(targetQ, L);
          this._prevHipsQuat.copy(hipsNode.quaternion);
        }
        // (else: silently skip this bad frame)
      }

      // Walking: shift the entire VRM scene based on Hips world position
      if (riggedPose.Hips.worldPosition && vrm.scene) {
        const hp = riggedPose.Hips.worldPosition;
        vrm.scene.position.x = THREE.MathUtils.lerp(
          vrm.scene.position.x, -hp.x * 0.5, L * 0.4
        );
        vrm.scene.position.z = THREE.MathUtils.lerp(
          vrm.scene.position.z,  hp.z * 0.5, L * 0.4
        );
      }
    }

    // ── Spine & Chest ─────────────────────────────────────────────────────────
    // Official Kalidokit pattern: use Spine data for BOTH spine & chest,
    // with different dampeners so the chest moves less than the spine.
    // Using riggedPose.Chest directly can fail because Kalidokit may not
    // always populate that key.
    this._rigRotation(VRMHumanBoneName.Spine, riggedPose.Spine, 0.45, L);
    this._rigRotation(VRMHumanBoneName.Chest, riggedPose.Spine, 0.25, L);

    // ── Neck & Head ───────────────────────────────────────────────────────────
    this._rigRotation(VRMHumanBoneName.Neck, riggedPose.Neck, 0.7, L);
    this._rigRotation(VRMHumanBoneName.Head, riggedPose.Head, 0.7, L);

    // ── Shoulders (必須先設定，否則手臂起始角度會錯誤) ─────────────────────────
    this._rigRotation(VRMHumanBoneName.RightShoulder, riggedPose.RightUpperArm, 0.3, L);
    this._rigRotation(VRMHumanBoneName.LeftShoulder,  riggedPose.LeftUpperArm,  0.3, L);

    // ── Arms — dampener=1: full range so lifting arms actually works ──────────
    this._rigRotation(VRMHumanBoneName.RightUpperArm, riggedPose.RightUpperArm, 1, L);
    this._rigRotation(VRMHumanBoneName.RightLowerArm, riggedPose.RightLowerArm, 1, L);
    this._rigRotation(VRMHumanBoneName.LeftUpperArm,  riggedPose.LeftUpperArm,  1, L);
    this._rigRotation(VRMHumanBoneName.LeftLowerArm,  riggedPose.LeftLowerArm,  1, L);

    // ── Legs, Feet & Toes ─────────────────────────────────────────────────────
    this._rigRotation(VRMHumanBoneName.RightUpperLeg, riggedPose.RightUpperLeg, 1, L);
    this._rigRotation(VRMHumanBoneName.RightLowerLeg, riggedPose.RightLowerLeg, 1, L);
    this._rigRotation(VRMHumanBoneName.LeftUpperLeg,  riggedPose.LeftUpperLeg,  1, L);
    this._rigRotation(VRMHumanBoneName.LeftLowerLeg,  riggedPose.LeftLowerLeg,  1, L);
    this._rigRotation(VRMHumanBoneName.RightFoot,     riggedPose.RightFoot,     1, L);
    this._rigRotation(VRMHumanBoneName.LeftFoot,      riggedPose.LeftFoot,      1, L);
    this._rigRotation(VRMHumanBoneName.RightToes,     riggedPose.RightFoot,     0.5, L);
    this._rigRotation(VRMHumanBoneName.LeftToes,      riggedPose.LeftFoot,      0.5, L);
  }

  // ─── Face Application ────────────────────────────────────────────────────────

  _applyRiggedFace(riggedFace) {
    const vrm = this.currentVrm;
    if (!vrm || !vrm.humanoid) return;

    const L = 1 - this.smoothingFactor;

    // Eye look (use riggedFace.eye object)
    if (riggedFace.eye) {
      this._rigRotation(VRMHumanBoneName.LeftEye,  riggedFace.eye, 0.8, L);
      this._rigRotation(VRMHumanBoneName.RightEye, riggedFace.eye, 0.8, L);
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
      { kali: `${p}ThumbProximal`,     vrm: side === 'Right' ? VRMHumanBoneName.RightThumbProximal     : VRMHumanBoneName.LeftThumbProximal     },
      // ThumbIntermediate (not ThumbMetacarpal) matches both model bone name & VRMHumanBoneName
      { kali: `${p}ThumbIntermediate`, vrm: side === 'Right' ? VRMHumanBoneName.RightThumbIntermediate : VRMHumanBoneName.LeftThumbIntermediate },
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
