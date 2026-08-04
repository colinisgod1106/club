/**
 * server.js — Express + WebSocket Signaling Server
 * Serves the built Vite app and relays WebRTC signaling between
 * the computer (index.html) and phone (camera.html).
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;

// ─── Static File Serving ──────────────────────────────────────────────────────
// Serve built Vite frontend from dist/
app.use(express.static(path.join(__dirname, 'dist')));

// Serve public/ directly (camera.html lives here for phone access)
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint (Render + Railway use this)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SPA fallback: all unknown routes serve index.html
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ─── WebRTC Signaling via WebSocket ──────────────────────────────────────────
/**
 * Room-based signaling:
 *  - Each room has exactly 2 participants: a "computer" and a "phone"
 *  - Messages are relayed between the two peers in the same room
 *
 * Message format (JSON):
 *  { type, roomId, role, ...payload }
 *
 *  type = 'join'    → client registers in a room with a role ('computer'|'phone')
 *  type = 'offer'   → SDP offer from phone → computer
 *  type = 'answer'  → SDP answer from computer → phone
 *  type = 'ice'     → ICE candidate (either direction)
 *  type = 'leave'   → client disconnecting
 */

// rooms: Map<roomId, { computer: WebSocket | null, phone: WebSocket | null }>
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { computer: null, phone: null });
  }
  return rooms.get(roomId);
}

function cleanupRoom(roomId, role) {
  const room = rooms.get(roomId);
  if (!room) return;
  room[role] = null;
  // If both sides gone, delete the room
  if (!room.computer && !room.phone) {
    rooms.delete(roomId);
    console.log(`[Room ${roomId}] Deleted (empty)`);
  }
}

function sendTo(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

wss.on('connection', (ws) => {
  let clientRoom = null;
  let clientRole = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, roomId, role } = msg;

    switch (type) {
      case 'join': {
        clientRoom = roomId || 'default';
        clientRole = role; // 'computer' or 'phone'

        const room = getOrCreateRoom(clientRoom);
        room[clientRole] = ws;

        console.log(`[Room ${clientRoom}] ${clientRole} joined. (computer: ${!!room.computer}, phone: ${!!room.phone})`);

        // Notify both sides about current room state
        sendTo(ws, { type: 'joined', roomId: clientRoom, role: clientRole });

        // If both sides are now present, notify computer that phone is ready
        if (room.computer && room.phone) {
          sendTo(room.computer, { type: 'phone-ready', roomId: clientRoom });
          sendTo(room.phone, { type: 'computer-ready', roomId: clientRoom });
        }
        break;
      }

      case 'offer': {
        const room = rooms.get(clientRoom);
        if (!room) break;
        console.log(`[Room ${clientRoom}] Relaying offer phone → computer`);
        sendTo(room.computer, { type: 'offer', sdp: msg.sdp });
        break;
      }

      case 'answer': {
        const room = rooms.get(clientRoom);
        if (!room) break;
        console.log(`[Room ${clientRoom}] Relaying answer computer → phone`);
        sendTo(room.phone, { type: 'answer', sdp: msg.sdp });
        break;
      }

      case 'ice': {
        const room = rooms.get(clientRoom);
        if (!room) break;
        // Relay ICE to the other peer
        const target = clientRole === 'phone' ? room.computer : room.phone;
        sendTo(target, { type: 'ice', candidate: msg.candidate });
        break;
      }

      case 'leave': {
        if (clientRoom && clientRole) {
          cleanupRoom(clientRoom, clientRole);
          const room = rooms.get(clientRoom);
          if (room) {
            const other = clientRole === 'phone' ? room.computer : room.phone;
            sendTo(other, { type: 'peer-left', role: clientRole });
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (clientRoom && clientRole) {
      console.log(`[Room ${clientRoom}] ${clientRole} disconnected.`);
      cleanupRoom(clientRoom, clientRole);
      const room = rooms.get(clientRoom);
      if (room) {
        const other = clientRole === 'phone' ? room.computer : room.phone;
        sendTo(other, { type: 'peer-left', role: clientRole });
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[WS Error]', err.message);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅  Anime VRM Tracker running on port ${PORT}`);
  console.log(`   Main app: http://localhost:${PORT}`);
  console.log(`   Phone cam: http://localhost:${PORT}/camera.html`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
});
