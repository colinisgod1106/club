import { VRMAvatar } from './vrmAvatar.js';
import { MotionTracker } from './tracker.js';

document.addEventListener('DOMContentLoaded', async () => {
  const canvas3D = document.getElementById('vrm-canvas');
  const videoInput = document.getElementById('input-video');
  const canvasOutput = document.getElementById('output-canvas');

  // Initialize 3D VRM Avatar Engine
  const avatar = new VRMAvatar(canvas3D);

  // Initialize MediaPipe Tracking Engine
  const tracker = new MotionTracker(
    videoInput,
    canvasOutput,
    (results, isBound) => {
      // Pass videoInput so Kalidokit can read the correct aspect ratio
      avatar.updateMotion(results, isBound, videoInput);
    }
  );

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

  // --- Phone Stream & Connection Management ---
  let currentRoomId = Math.floor(100000 + Math.random() * 900000).toString();

  async function startPhoneConnection(keepRoom = true) {
    if (!keepRoom) {
      currentRoomId = Math.floor(100000 + Math.random() * 900000).toString();
    }
    const roomIdDisplay = document.getElementById('room-id-display');
    if (roomIdDisplay) roomIdDisplay.textContent = currentRoomId;

    // Determine host URL (check custom host input first)
    const customHostVal = document.getElementById('custom-host-input')?.value?.trim();
    let baseOrigin = location.origin;
    if (customHostVal) {
      baseOrigin = customHostVal.startsWith('http') ? customHostVal : `${location.protocol}//${customHostVal}`;
    }

    const cameraUrl = `${baseOrigin}/camera.html?room=${currentRoomId}`;
    const phoneUrlText = document.getElementById('phone-url-text');
    if (phoneUrlText) phoneUrlText.textContent = cameraUrl;

    const phoneQrCanvas = document.getElementById('phone-qr-canvas');
    if (phoneQrCanvas) drawQrCode(phoneQrCanvas, cameraUrl);

    await tracker.startPhoneStream(currentRoomId, (state) => {
      updatePhoneStatusUI(state);
    });
  }

  // --- Source Selection Event Listeners ---
  const btnPhone = document.getElementById('src-phone');
  const btnWebcam = document.getElementById('src-webcam');
  const btnScreen = document.getElementById('src-screen');
  const phonePanel = document.getElementById('phone-panel');

  btnPhone?.addEventListener('click', async () => {
    btnPhone.classList.add('active');
    btnWebcam?.classList.remove('active');
    btnScreen?.classList.remove('active');
    phonePanel?.classList.remove('hidden');
    await startPhoneConnection(true);
  });

  btnWebcam?.addEventListener('click', async () => {
    btnWebcam.classList.add('active');
    btnPhone?.classList.remove('active');
    btnScreen?.classList.remove('active');
    phonePanel?.classList.add('hidden');
    tracker.stopPhoneStream();
    try {
      await tracker.startCamera();
    } catch (err) {
      console.warn('視訊鏡頭開啟失敗:', err);
      const trackingQuality = document.getElementById('tracking-quality');
      if (trackingQuality) trackingQuality.textContent = '無內建鏡頭';
    }
  });

  btnScreen?.addEventListener('click', async () => {
    btnScreen.classList.add('active');
    btnPhone?.classList.remove('active');
    btnWebcam?.classList.remove('active');
    phonePanel?.classList.add('hidden');
    await tracker.startScreenShare();
  });

  // Reconnect / New Room / Apply Host Buttons
  document.getElementById('btn-reconnect-phone')?.addEventListener('click', async () => {
    await startPhoneConnection(true);
  });

  document.getElementById('btn-new-room')?.addEventListener('click', async () => {
    await startPhoneConnection(false);
  });

  document.getElementById('btn-apply-host')?.addEventListener('click', async () => {
    await startPhoneConnection(true);
  });

  // Start with Phone Camera mode by default
  await startPhoneConnection(true);

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

  // Sliders: Smoothing
  const sliderSmoothing = document.getElementById('slider-smoothing');
  const valSmoothing = document.getElementById('val-smoothing');
  sliderSmoothing.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    avatar.smoothingFactor = val;
    valSmoothing.textContent = val.toFixed(2);
  });
});

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
