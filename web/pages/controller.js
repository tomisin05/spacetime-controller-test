import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import { Timestamp } from "spacetimedb";
import { DbConnection } from "../module_bindings";

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI || "wss://maincloud.spacetimedb.com";
const MODULE_NAME = process.env.NEXT_PUBLIC_SPACETIME_MODULE || "test-hop-hacks-dfa4f";

function ModeLinks({ mode }) {
  return <div style={{ position: "fixed", top: 16, right: 16 }}>
    <a href="/controller?mode=cloud" style={{ color: mode === "cloud" ? "#6cf" : "#888", marginRight: 12 }}>Cloud</a>
    <a href="/controller?mode=lan" style={{ color: mode === "lan" ? "#6f6" : "#888", marginRight: 12 }}>LAN</a>
    <a href="/controller?mode=direct" style={{ color: mode === "direct" ? "#fc6" : "#888" }}>Direct</a>
  </div>;
}

function Joystick({ status, rtt, onInput, mode, children }) {
  const joyRef = useRef(null);
  const dragging = useRef(false);

  function handlePointer(event) {
    if (!dragging.current) return;
    const rect = joyRef.current.getBoundingClientRect();
    let x = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    let y = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    const magnitude = Math.min(1, Math.hypot(x, y));
    const angle = Math.atan2(y, x);
    onInput(Math.cos(angle) * magnitude, Math.sin(angle) * magnitude);
  }

  function startPointer(event) {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    handlePointer(event);
  }

  function stopPointer(event) {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onInput(0, 0);
  }

  return <div style={{ background: "#000", minHeight: "100vh", color: "#fff", fontFamily: "monospace", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", touchAction: "none" }}>
    <ModeLinks mode={mode} />
    <div style={{ marginBottom: 24, textAlign: "center", padding: 12 }}>{status}{rtt !== null && ` — RTT: ${rtt}ms`}</div>
    <div ref={joyRef} onPointerDown={startPointer} onPointerUp={stopPointer} onPointerCancel={stopPointer} onPointerMove={handlePointer} style={{ width: 220, height: 220, borderRadius: "50%", border: "2px solid #444", background: "#111" }} />
    {children}
  </div>;
}

function CloudController() {
  const connection = useRef(null);
  const [connected, setConnected] = useState(false);
  const [rtt, setRtt] = useState(null);

  useEffect(() => {
    let pingInterval;
    const conn = DbConnection.builder().withUri(SPACETIME_URI).withDatabaseName(MODULE_NAME)
      .onConnect((active) => {
        setConnected(true);
        active.subscriptionBuilder().subscribe(["SELECT * FROM ping_log"]);
        pingInterval = setInterval(() => {
          const sentAt = Date.now();
          active._lastPingSentAt = sentAt;
          active.reducers.ping({ clientSentAt: Timestamp.fromDate(new Date(sentAt)) });
        }, 1000);
      }).onDisconnect(() => setConnected(false)).build();
    connection.current = conn;
    const updateRtt = (ctx, row) => {
      if (row.identity.isEqual(conn.identity) && conn._lastPingSentAt) setRtt(Date.now() - conn._lastPingSentAt);
    };
    conn.db.pingLog.onInsert(updateRtt);
    conn.db.pingLog.onUpdate((ctx, oldRow, newRow) => updateRtt(ctx, newRow));
    return () => { clearInterval(pingInterval); conn.disconnect(); };
  }, []);

  return <Joystick mode="cloud" status={connected ? "Connected to Maincloud" : "Connecting to Maincloud..."} rtt={rtt} onInput={(x, y) => connection.current?.reducers.sendInput({ inputX: x, inputY: y })} />;
}

function LanController() {
  const socketRef = useRef(null);
  const retryRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [rtt, setRtt] = useState(null);
  const [serverUrl, setServerUrl] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("server") || process.env.NEXT_PUBLIC_LAN_WS_URI || `ws://${window.location.hostname}:8787`;
    setServerUrl(url);
    let stopped = false;
    let pingInterval;
    const connect = () => {
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        setConnected(true);
        socket.send(JSON.stringify({ type: "hello", role: "controller" }));
        pingInterval = setInterval(() => socket.send(JSON.stringify({ type: "ping", sentAt: Date.now() })), 1000);
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "pong") setRtt(Date.now() - message.sentAt);
      };
      socket.onclose = () => {
        setConnected(false);
        clearInterval(pingInterval);
        if (!stopped) retryRef.current = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => { stopped = true; clearInterval(pingInterval); clearTimeout(retryRef.current); socketRef.current?.close(); };
  }, []);

  const sendInput = (x, y) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "input", x, y }));
  };
  const status = connected ? `Connected over LAN (${serverUrl})` : `Connecting to LAN server (${serverUrl || "detecting..."})`;
  return <Joystick mode="lan" status={status} rtt={rtt} onInput={sendInput} />;
}

function decodeSignal(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(base64))));
}

function encodeSignal(value) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function waitForIce(connection) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      if (connection.iceGatheringState === "complete") {
        connection.removeEventListener("icegatheringstatechange", listener);
        resolve();
      }
    };
    connection.addEventListener("icegatheringstatechange", listener);
  });
}

function DirectController() {
  const peerRef = useRef(null);
  const channelRef = useRef(null);
  const signalRef = useRef(null);
  const joiningRef = useRef(false);
  const [roomCode, setRoomCode] = useState("");
  const [status, setStatus] = useState("Enter the six-digit code shown on the laptop");

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("room") || "";
    if (/^\d{6}$/.test(code)) {
      setRoomCode(code);
      joinRoom(code);
    }
    return () => {
      peerRef.current?.close();
      signalRef.current?.disconnect();
    };
  }, []);

  async function answerRoom(room, connection) {
    if (joiningRef.current || !room.offer) return;
    joiningRef.current = true;
    try {
      setStatus("Pairing directly with laptop...");
      const peer = new RTCPeerConnection({ iceServers: [] });
      peerRef.current = peer;
      peer.ondatachannel = ({ channel }) => {
        channelRef.current = channel;
        channel.onopen = () => {
          setStatus("Connected directly to laptop");
          connection.disconnect();
        };
        channel.onclose = () => setStatus("Direct connection closed");
        channel.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          if (message.type === "ping" && channel.readyState === "open") channel.send(JSON.stringify({ type: "pong", sentAt: message.sentAt }));
        };
      };
      await peer.setRemoteDescription(decodeSignal(room.offer));
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIce(peer);
      connection.reducers.answerSignalRoom({ code: room.code, answer: encodeSignal(peer.localDescription) });
      setStatus("Waiting for laptop to finish pairing...");
    } catch (error) {
      setStatus(`Pairing failed: ${error.message}`);
      joiningRef.current = false;
    }
  }

  function joinRoom(rawCode = roomCode) {
    const code = rawCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setStatus("Room code must contain six digits");
      return;
    }
    signalRef.current?.disconnect();
    joiningRef.current = false;
    setStatus("Finding room...");
    let connection;
    connection = DbConnection.builder().withUri(SPACETIME_URI).withDatabaseName(MODULE_NAME)
      .onConnect((active) => {
        active.subscriptionBuilder().onApplied(() => {
          const room = [...active.db.signalRoom.iter()][0];
          if (room) answerRoom(room, active);
          else setStatus("Room not found. Check the code and try again.");
        }).subscribe([`SELECT * FROM signal_room WHERE code = '${code}'`]);
      })
      .onConnectError((ctx, error) => setStatus(`Pairing service error: ${error.message}`))
      .build();
    signalRef.current = connection;
    connection.db.signalRoom.onInsert((ctx, room) => answerRoom(room, connection));
  }

  const sendInput = (x, y) => {
    if (channelRef.current?.readyState === "open") channelRef.current.send(JSON.stringify({ type: "input", x, y }));
  };

  return <Joystick mode="direct" status={status} rtt={null} onInput={sendInput}>
    <div style={{ width: "min(92vw, 360px)", marginTop: 24, textAlign: "center" }}>
      <input inputMode="numeric" pattern="[0-9]*" maxLength={6} value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/\D/g, ""))} placeholder="Room code" style={{ width: 180, fontSize: 28, textAlign: "center", letterSpacing: 6 }} />
      <br /><button onClick={() => joinRoom()} disabled={roomCode.length !== 6} style={{ marginTop: 8 }}>Join room</button>
    </div>
  </Joystick>;
}

export default function Controller() {
  const router = useRouter();
  if (router.query.mode === "direct") return <DirectController />;
  if (router.query.mode === "lan") return <LanController />;
  return <CloudController />;
}
