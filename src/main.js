import { VRMAvatar } from './vrmAvatar.js';
import { MotionTracker } from './tracker.js';

document.addEventListener('DOMContentLoaded', async () => {
  const canvas3D = document.getElementById('vrm-canvas');
  const videoInput = document.getElementById('input-video');
  const canvasOutput = document.getElementById('output-canvas');

  // Initialize 3D VRM Avatar Engine
  const avatar = new VRMAvatar(canvas3D);

  // Initialize MediaPipe & Gesture Tracking Engine
  const tracker = new MotionTracker(
    videoInput,
    canvasOutput,
    (results, isBound) => {
      avatar.updateMotion(results, isBound);
    },
    (detectedGesture) => {
      updateGestureUI(detectedGesture);
    }
  );

  // Start Webcam Tracking by default
  await tracker.startCamera();

  // --- UI Event Handlers ---

  // Camera Reset
  document.getElementById('btn-reset-cam').addEventListener('click', () => {
    avatar.resetCamera();
  });

  // Toggle Grid
  document.getElementById('btn-toggle-grid').addEventListener('click', () => {
    avatar.toggleGrid();
  });

  // Toggle Manual Bind/Unbind Status
  document.getElementById('btn-toggle-bind').addEventListener('click', () => {
    tracker.toggleBindStatus();
  });

  // Source Selector: Webcam vs Screen Share
  const btnWebcam = document.getElementById('src-webcam');
  const btnScreen = document.getElementById('src-screen');
  const btnPhone  = document.getElementById('src-phone');

  btnWebcam.addEventListener('click', async () => {
    btnWebcam.classList.add('active');
    btnScreen.classList.remove('active');
    btnPhone.classList.remove('active');
    document.getElementById('phone-panel').classList.add('hidden');
    tracker.stopPhoneStream();
    await tracker.startCamera();
  });

  btnScreen.addEventListener('click', async () => {
    btnScreen.classList.add('active');
    btnWebcam.classList.remove('active');
    btnPhone.classList.remove('active');
    document.getElementById('phone-panel').classList.add('hidden');
    await tracker.startScreenShare();
  });

  btnPhone.addEventListener('click', async () => {
    btnPhone.classList.add('active');
    btnWebcam.classList.remove('active');
    btnScreen.classList.remove('active');

    // Generate room ID and show panel
    const roomId = Math.floor(100000 + Math.random() * 900000).toString();
    const phonePanel = document.getElementById('phone-panel');
    phonePanel.classList.remove('hidden');
    document.getElementById('room-id-display').textContent = roomId;

    // Build camera URL
    const cameraUrl = `${location.origin}/camera.html?room=${roomId}`;
    document.getElementById('phone-url-text').textContent = cameraUrl;

    // Draw QR Code on canvas
    drawQrCode(document.getElementById('phone-qr-canvas'), cameraUrl);

    // Start WebRTC receiver
    await tracker.startPhoneStream(roomId, (state) => {
      updatePhoneStatusUI(state);
    });
  });

  // Model Preset Selection & Custom VRM Upload
  const modelPresetSelect = document.getElementById('model-preset');
  const uploadBox = document.getElementById('vrm-upload-box');
  const fileInput = document.getElementById('vrm-file-input');

  modelPresetSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'custom') {
      uploadBox.classList.remove('hidden');
    } else {
      uploadBox.classList.add('hidden');
      // val is a path like /models/model1.vrm
      avatar.loadModel(val);
    }
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      avatar.loadModel(file);
    }
  });

  // Drag & Drop VRM onto Upload Box
  uploadBox.addEventListener('dragover', (e) => e.preventDefault());
  uploadBox.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.vrm') || file.name.endsWith('.glb'))) {
      avatar.loadModel(file);
    }
  });

  // Sliders: Smoothing & Gesture Hold Threshold
  const sliderSmoothing = document.getElementById('slider-smoothing');
  const valSmoothing = document.getElementById('val-smoothing');
  sliderSmoothing.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    avatar.smoothingFactor = val;
    valSmoothing.textContent = val.toFixed(2);
  });

  const sliderGestureHold = document.getElementById('slider-gesture-hold');
  const valGestureHold = document.getElementById('val-gesture-hold');
  sliderGestureHold.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    tracker.gestureHoldDurationThreshold = val * 1000;
    valGestureHold.textContent = `${val.toFixed(1)}s`;
  });
});

// Update Gesture HUD UI Badge
function updateGestureUI(gesture) {
  const gestureBadge = document.getElementById('gesture-detected');
  const gestureName = document.getElementById('gesture-name');
  const gestureIcon = gestureBadge.querySelector('.gesture-icon');

  switch (gesture) {
    case 'VICTORY':
      gestureIcon.textContent = '✌️';
      gestureName.textContent = '剪刀手 (Binding Toggle)';
      gestureBadge.style.borderColor = '#00f0ff';
      break;
    case 'OPEN_PALM':
      gestureIcon.textContent = '✋';
      gestureName.textContent = '開掌 (Reset Pose)';
      gestureBadge.style.borderColor = '#ffb703';
      break;
    case 'FIST':
      gestureIcon.textContent = '✊';
      gestureName.textContent = '握拳 (Lock Pose)';
      gestureBadge.style.borderColor = '#ff2a8d';
      break;
    default:
      gestureIcon.textContent = '🖐️';
      gestureName.textContent = '無手勢';
      gestureBadge.style.borderColor = '#9d4edd';
      break;
  }
}

// Update Phone Stream Connection Status UI
function updatePhoneStatusUI(state) {
  const dot  = document.getElementById('phone-status-dot');
  const text = document.getElementById('phone-status-text');
  if (!dot || !text) return;

  const states = {
    waiting:    { cls: 'waiting',    label: '⏳ 等待手機連線...' },
    connecting: { cls: 'connecting', label: '🔄 手機已就緒，建立連線中...' },
    connected:  { cls: 'connected',  label: '✅ 手機串流已連線！' },
    error:      { cls: 'error',      label: '❌ 連線失敗，請重試' },
  };

  const s = states[state] || states.waiting;
  dot.className = `phone-status-dot ${s.cls}`;
  text.textContent = s.label;
}

// QR Code Generator (uses qrcode-generator loaded from CDN)
function drawQrCode(canvas, text) {
  // Dynamically load qrcode-generator if not yet loaded
  if (typeof qrcode !== 'undefined') {
    _renderQr(canvas, text);
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
  script.onload = () => _renderQr(canvas, text);
  document.head.appendChild(script);
}

function _renderQr(canvas, text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const moduleCount = qr.getModuleCount();
    const tileSize = Math.floor(size / moduleCount);
    const offset = Math.floor((size - tileSize * moduleCount) / 2);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#0a0c14';

    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(
            offset + col * tileSize,
            offset + row * tileSize,
            tileSize, tileSize
          );
        }
      }
    }
  } catch (e) {
    console.warn('QR generation failed:', e);
  }
}
