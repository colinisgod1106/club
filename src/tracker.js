const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export class MotionTracker {
  constructor(videoElement, canvasElement, onResultsCallback) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.onResults = onResultsCallback;

    this.isBound = false;

    this.fpsCount = 0;
    this.lastFpsUpdate = performance.now();
    this.currentFps = 0;

    // WebRTC state
    this._ws = null;
    this._pc = null;
    this._phoneRoomId = null;

    this._initHolistic();
  }

  _initHolistic() {
    const HolisticClass = window.Holistic || Holistic;
    
    this.holistic = new HolisticClass({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}`
    });

    this.holistic.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      smoothSegmentation: false,
      refineFaceLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    this.holistic.onResults((results) => this._handleResults(results));
  }

  async startCamera() {
    this._stopCurrentSource();

    try {
      const CameraClass = window.Camera || Camera;

      this.camera = new CameraClass(this.video, {
        onFrame: async () => {
          await this.holistic.send({ image: this.video });
        },
        width: 640,
        height: 480
      });

      await this.camera.start();
    } catch (err) {
      console.warn('MediaPipe Camera 啟動失敗 (可能無鏡頭):', err);
      this.camera = null;
      throw err;
    }
  }

  async startScreenShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false
      });

      this._stopCurrentSource();

      this.video.srcObject = stream;
      this.video.play();

      const processFrame = async () => {
        if (!this.video.paused && !this.video.ended) {
          await this.holistic.send({ image: this.video });
          requestAnimationFrame(processFrame);
        }
      };
      processFrame();
    } catch (err) {
      console.error('Error starting screen capture:', err);
    }
  }

  // ─── WebRTC Phone Stream (Receiver Side) ────────────────────────────────────

  /**
   * Start receiving video from a phone via WebRTC.
   * @param {string} roomId - Shared 6-digit room ID shown in the UI
   * @param {Function} onStateChange - Called with state strings: 'waiting'|'connecting'|'connected'|'error'
   */
  async startPhoneStream(roomId, onStateChange) {
    this._stopCurrentSource();
    this._phoneRoomId = roomId;
    onStateChange?.('waiting');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    this._ws = new WebSocket(wsUrl);

    this._ws.onopen = () => {
      console.log('[WebRTC] Signaling connected');
      this._ws.send(JSON.stringify({ type: 'join', roomId, role: 'computer' }));
    };

    this._ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      console.log('[WebRTC] Signal received:', msg.type);

      if (msg.type === 'phone-ready') {
        onStateChange?.('connecting');
        console.log('[WebRTC] Phone is ready, waiting for offer...');
      } else if (msg.type === 'offer') {
        await this._handleOffer(msg.sdp, roomId, onStateChange);
      } else if (msg.type === 'ice') {
        if (this._pc && msg.candidate) {
          try {
            await this._pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (e) {
            console.warn('[WebRTC] ICE add failed:', e.message);
          }
        }
      } else if (msg.type === 'peer-left') {
        console.log('[WebRTC] Phone disconnected');
        onStateChange?.('waiting');
      }
    };

    this._ws.onerror = (e) => {
      console.error('[WebRTC] WebSocket error:', e);
      onStateChange?.('error');
    };
  }

  async _handleOffer(sdp, roomId, onStateChange) {
    this._pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });

    this._pc.ontrack = (event) => {
      console.log('[WebRTC] Received remote track');
      const [remoteStream] = event.streams;
      this.video.srcObject = remoteStream;
      this.video.play();

      // Start MediaPipe loop on remote stream
      const processFrame = async () => {
        if (!this.video.paused && !this.video.ended && this.video.readyState >= 2) {
          await this.holistic.send({ image: this.video });
        }
        requestAnimationFrame(processFrame);
      };
      processFrame();

      onStateChange?.('connected');
    };

    this._pc.onicecandidate = ({ candidate }) => {
      if (candidate && this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: 'ice', roomId, candidate }));
      }
    };

    this._pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state:', this._pc.iceConnectionState);
      if (this._pc.iceConnectionState === 'failed') {
        onStateChange?.('error');
      }
    };

    await this._pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);

    this._ws.send(JSON.stringify({ type: 'answer', roomId, sdp: this._pc.localDescription }));
    console.log('[WebRTC] Answer sent');
  }

  stopPhoneStream() {
    if (this._pc) { this._pc.close(); this._pc = null; }
    if (this._ws) {
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: 'leave', roomId: this._phoneRoomId }));
      }
      this._ws.close();
      this._ws = null;
    }
    this.video.srcObject = null;
    this._phoneRoomId = null;
  }

  _stopCurrentSource() {
    // Stop MediaPipe Camera utility (webcam mode)
    if (this.camera) {
      this.camera.stop();
      this.camera = null;
    }
    // Stop WebRTC if active
    if (this._pc || this._ws) {
      this.stopPhoneStream();
    }
    // Stop any other srcObject stream tracks
    const stream = this.video.srcObject;
    if (stream) {
      stream.getTracks?.().forEach(t => t.stop());
      this.video.srcObject = null;
    }
  }

  _handleResults(results) {
    this._updateFps();
    this._drawLandmarks(results);

    if (this.onResults) {
      this.onResults(results, this.isBound);
    }
  }

  _updateFps() {
    this.fpsCount++;
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 1000) {
      this.currentFps = this.fpsCount;
      this.fpsCount = 0;
      this.lastFpsUpdate = now;
      const fpsEl = document.getElementById('fps-counter');
      if (fpsEl) fpsEl.textContent = `FPS: ${this.currentFps}`;
    }
  }

  _drawLandmarks(results) {
    if (!this.ctx || !this.canvas) return;

    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;

    this.ctx.save();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw Pose Keypoints with Glowing Cyan Lines
    if (results.poseLandmarks) {
      this.ctx.strokeStyle = '#00f0ff';
      this.ctx.lineWidth = 3;
      this.ctx.fillStyle = '#ff2a8d';

      results.poseLandmarks.forEach((lm) => {
        const x = lm.x * this.canvas.width;
        const y = lm.y * this.canvas.height;
        this.ctx.beginPath();
        this.ctx.arc(x, y, 4, 0, 2 * Math.PI);
        this.ctx.fill();
      });
    }

    // Draw Hand Keypoints with Gold / Pink Nodes
    [results.rightHandLandmarks, results.leftHandLandmarks].forEach((hand) => {
      if (hand) {
        this.ctx.fillStyle = '#ffb703';
        hand.forEach((lm) => {
          const x = lm.x * this.canvas.width;
          const y = lm.y * this.canvas.height;
          this.ctx.beginPath();
          this.ctx.arc(x, y, 3, 0, 2 * Math.PI);
          this.ctx.fill();
        });
      }
    });

    this.ctx.restore();
  }

  toggleBindStatus() {
    this.isBound = !this.isBound;
    this._updateStatusUI();
  }

  _updateStatusUI() {
    const statusBadge = document.getElementById('sync-status');
    const statusText = document.getElementById('status-text');
    const bindBtnLabel = document.getElementById('bind-btn-label');

    if (this.isBound) {
      statusBadge.className = 'status-badge bound';
      statusText.textContent = 'BOUND // 姿態同步中';
      if (bindBtnLabel) bindBtnLabel.textContent = '⚡ 解除姿態跟隨';
    } else {
      statusBadge.className = 'status-badge unbound';
      statusText.textContent = 'UNBOUND // 待機中';
      if (bindBtnLabel) bindBtnLabel.textContent = '⚡ 綁定姿態跟隨';
    }
  }
}
