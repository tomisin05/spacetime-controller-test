const { randomUUID } = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.LAN_WS_PORT || 8787);
const TICK_MS = 50;
const SPEED = 180;
const clients = new Map();

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function snapshot() {
  return [...clients.values()]
    .filter((client) => client.role === "controller")
    .map(({ id, x, y }) => ({ id, x, y }));
}

function broadcastState() {
  const message = JSON.stringify({ type: "state", players: snapshot() });
  for (const client of clients.values()) {
    if (client.role === "display" && client.socket.readyState === WebSocket.OPEN) client.socket.send(message);
  }
}

const wss = new WebSocketServer({ host: "0.0.0.0", port: PORT });

wss.on("connection", (socket) => {
  const client = { id: randomUUID(), socket, role: "unknown", x: 0, y: 0, inputX: 0, inputY: 0 };
  clients.set(client.id, client);
  send(socket, { type: "welcome", id: client.id });

  socket.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === "hello" && ["controller", "display"].includes(message.role)) {
      client.role = message.role;
      if (client.role === "display") send(socket, { type: "state", players: snapshot() });
      broadcastState();
    } else if (message.type === "input" && client.role === "controller") {
      const inputX = Number(message.x);
      const inputY = Number(message.y);
      if (!Number.isFinite(inputX) || !Number.isFinite(inputY)) return;
      const magnitude = Math.hypot(inputX, inputY);
      const scale = magnitude > 1 ? 1 / magnitude : 1;
      client.inputX = inputX * scale;
      client.inputY = inputY * scale;
    } else if (message.type === "ping") {
      send(socket, { type: "pong", sentAt: message.sentAt });
    }
  });

  socket.on("close", () => {
    clients.delete(client.id);
    broadcastState();
  });
});

setInterval(() => {
  const seconds = TICK_MS / 1000;
  for (const client of clients.values()) {
    if (client.role !== "controller") continue;
    client.x += client.inputX * SPEED * seconds;
    client.y += client.inputY * SPEED * seconds;
  }
  broadcastState();
}, TICK_MS);

console.log(`LAN controller server listening on ws://0.0.0.0:${PORT}`);
