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
    
    // Smoothing / LERP configuration
    this.smoothingFactor = 0.8;
    this.previousBoneRotations = new Map();

    this._initScene();
    this._initLights();
    this._initControls();
    this._animate();

    // Default VRM models (local)
    this.defaultVrmUrl = '/models/model2.vrm'; // 輕量角色 9MB，載入較快
    this.model1Url = '/models/model1.vrm';
    this.model2Url = '/models/model2.vrm';
    this.loadModel(this.defaultVrmUrl);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c14);

    this.camera = new THREE.PerspectiveCamera(
      35,
      this.canvas.clientWidth / this.canvas.clientHeight,
      0.1,
      20.0
    );
    this.camera.position.set(0, 1.4, 2.5);

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

    // Grid Floor
    this.gridHelper = new THREE.GridHelper(10, 20, 0x00f0ff, 0x1c2438);
    this.gridHelper.position.y = 0;
    this.scene.add(this.gridHelper);

    // Handle Window Resize
    window.addEventListener('resize', () => this.onWindowResize());
  }

  _initLights() {
    // Key Directional Light for Anime Toon Shading
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.4);
    mainLight.position.set(1.5, 3.0, 2.0);
    this.scene.add(mainLight);

    // Cyan Fill Light for Sci-Fi / Anime Ambient Glow
    const fillLight = new THREE.DirectionalLight(0x00f0ff, 0.6);
    fillLight.position.set(-2.0, 1.5, -1.0);
    this.scene.add(fillLight);

    // Purple Rim Light (Star Rail style)
    const rimLight = new THREE.DirectionalLight(0x9d4edd, 0.8);
    rimLight.position.set(0.0, 2.5, -2.5);
    this.scene.add(rimLight);

    // Soft Ambient Light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambientLight);
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.2, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.1;
    this.controls.minDistance = 1.0;
    this.controls.maxDistance = 6.0;
    this.controls.update();
  }

  resetCamera() {
    this.camera.position.set(0, 1.4, 2.5);
    this.controls.target.set(0, 1.2, 0);
    this.controls.update();
  }

  toggleGrid() {
    this.gridHelper.visible = !this.gridHelper.visible;
  }

  loadModel(urlOrFile) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const loadingUrl = typeof urlOrFile === 'string' ? urlOrFile : URL.createObjectURL(urlOrFile);

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

        // Standard VRM orientation setup
        VRMUtils.rotateVRM0(vrm);
        vrm.scene.position.set(0, 0, 0);

        // Adjust camera target to character chest
        this.controls.target.set(0, 1.2, 0);
        this.controls.update();

        console.log('VRM Model Loaded Successfully:', vrm);
      },
      (progress) => {
        console.log(`Loading VRM: ${((progress.loaded / progress.total) * 100).toFixed(1)}%`);
      },
      (error) => {
        console.warn('Failed to load VRM model from URL. Creating fallback 3D mannequin.', error);
        this._createFallbackAvatar();
      }
    );
  }

  _createFallbackAvatar() {
    if (this.currentVrm) {
      this.scene.remove(this.currentVrm.scene);
    }
    
    const group = new THREE.Group();
    const mat = new THREE.MeshToonMaterial({ color: 0x00f0ff, wireframe: false });

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), mat);
    head.position.set(0, 1.5, 0);
    group.add(head);

    // Torso
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.5), mat);
    torso.position.set(0, 1.1, 0);
    group.add(torso);

    this.scene.add(group);
  }

  updateMotion(results, isBound) {
    if (!this.currentVrm || !isBound) return;

    const poseLandmarks = results.poseLandmarks;
    const pose3DLandmarks = results.ea || results.poseWorldLandmarks || poseLandmarks;
    const rightHandLandmarks = results.rightHandLandmarks;
    const leftHandLandmarks = results.leftHandLandmarks;

    if (!poseLandmarks) return;

    const Kali = window.Kalidokit;
    if (!Kali) return;

    // Solve Pose with Kalidokit
    const riggedPose = Kali.Pose.solve(pose3DLandmarks, poseLandmarks, {
      runtime: 'mediapipe',
      video: null,
      enableLegs: true
    });

    if (riggedPose) {
      this._applyRiggedPose(riggedPose);
    }

    // Solve Hands
    if (rightHandLandmarks) {
      const riggedRightHand = Kali.Hand.solve(rightHandLandmarks, 'Right');
      if (riggedRightHand) this._applyRiggedHand(riggedRightHand, 'Right');
    }
    if (leftHandLandmarks) {
      const riggedLeftHand = Kali.Hand.solve(leftHandLandmarks, 'Left');
      if (riggedLeftHand) this._applyRiggedHand(riggedLeftHand, 'Left');
    }
  }

  _applyRiggedPose(riggedPose) {
    const vrm = this.currentVrm;
    if (!vrm || !vrm.humanoid) return;

    const boneMap = {
      Hips: VRMHumanBoneName.Hips,
      Spine: VRMHumanBoneName.Spine,
      Chest: VRMHumanBoneName.Chest,
      Neck: VRMHumanBoneName.Neck,
      Head: VRMHumanBoneName.Head,
      RightUpperArm: VRMHumanBoneName.RightUpperArm,
      RightLowerArm: VRMHumanBoneName.RightLowerArm,
      LeftUpperArm: VRMHumanBoneName.LeftUpperArm,
      LeftLowerArm: VRMHumanBoneName.LeftLowerArm,
      RightUpperLeg: VRMHumanBoneName.RightUpperLeg,
      RightLowerLeg: VRMHumanBoneName.RightLowerLeg,
      LeftUpperLeg: VRMHumanBoneName.LeftUpperLeg,
      LeftLowerLeg: VRMHumanBoneName.LeftLowerLeg
    };

    for (const [kaliName, vrmBoneName] of Object.entries(boneMap)) {
      if (riggedPose[kaliName]) {
        const boneNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
        if (boneNode) {
          const rot = riggedPose[kaliName];
          const targetEuler = new THREE.Euler(rot.x, rot.y, rot.z, 'XYZ');
          const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);

          boneNode.quaternion.slerp(targetQuat, 1 - this.smoothingFactor);
        }
      }
    }
  }

  _applyRiggedHand(riggedHand, side) {
    const vrm = this.currentVrm;
    if (!vrm || !vrm.humanoid) return;

    const prefix = side === 'Right' ? 'Right' : 'Left';
    const wristBone = vrm.humanoid.getNormalizedBoneNode(
      side === 'Right' ? VRMHumanBoneName.RightHand : VRMHumanBoneName.LeftHand
    );

    if (wristBone && riggedHand[`${prefix}Wrist`]) {
      const rot = riggedHand[`${prefix}Wrist`];
      const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot.x, rot.y, rot.z));
      wristBone.quaternion.slerp(targetQuat, 1 - this.smoothingFactor);
    }
  }

  onWindowResize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());

    const delta = this.clock.getDelta();

    if (this.currentVrm) {
      this.currentVrm.update(delta);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
