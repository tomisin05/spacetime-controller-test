import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import { Timestamp } from "spacetimedb";
import { DbConnection } from "../module_bindings";

const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI || "wss://maincloud.spacetimedb.com";
const MODULE_NAME = process.env.NEXT_PUBLIC_SPACETIME_MODULE || "test-hop-hacks-dfa4f";

function Display({ mode, connected, rtt, players, serverUrl }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    let frame;
    const draw = () => {
      context.fillStyle = "#111";
      context.fillRect(0, 0, canvas.width, canvas.height);
      players.forEach((player, index) => {
        context.fillStyle = `hsl(${index * 90}, 80%, 60%)`;
        context.beginPath();
        context.arc(canvas.width / 2 + player.x, canvas.height / 2 + player.y, 12, 0, Math.PI * 2);
        context.fill();
      });
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [players]);

  const controllerHref = mode === "lan"
    ? `/controller?mode=lan${serverUrl ? `&server=${encodeURIComponent(serverUrl)}` : ""}`
    : `/controller?mode=${mode}`;
  return <div style={{ background: "#000", minHeight: "100vh", color: "#fff", fontFamily: "monospace" }}>
    <div style={{ padding: 12 }}>
      <strong>{mode === "direct" ? "Direct WebRTC Display" : mode === "lan" ? "LAN Display" : "Maincloud Display"}</strong> — {connected ? "connected" : "connecting..."}{rtt !== null && ` — RTT: ${rtt} ms`}
      <br />Connected controllers: {players.length}
      {serverUrl && <><br />Server: {serverUrl}</>}
      <br /><a href={controllerHref} style={{ color: "#6cf" }}>Open or copy matching controller link</a>
      <br /><a href="/play?mode=cloud" style={{ color: mode === "cloud" ? "#6cf" : "#888" }}>Cloud</a>
      <span> · </span><a href="/play?mode=lan" style={{ color: mode === "lan" ? "#6f6" : "#888" }}>LAN</a>
      <span> · </span><a href="/play?mode=direct" style={{ color: mode === "direct" ? "#fc6" : "#888" }}>Direct</a>
    </div>
    <canvas ref={canvasRef} width={600} height={600} style={{ display: "block", margin: "0 auto", maxWidth: "100%" }} />
  </div>;
}

function CloudPlay() {
  const [connected, setConnected] = useState(false);
  const [rtt, setRtt] = useState(null);
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    let pingInterval;
    const conn = DbConnection.builder().withUri(SPACETIME_URI).withDatabaseName(MODULE_NAME)
      .onConnect((active) => {
        setConnected(true);
        active.reducers.registerAsDisplay({});
        active.subscriptionBuilder().subscribe(["SELECT * FROM player", "SELECT * FROM ping_log"]);
        pingInterval = setInterval(() => {
          const sentAt = Date.now();
          active._lastPingSentAt = sentAt;
          active.reducers.ping({ clientSentAt: Timestamp.fromDate(new Date(sentAt)) });
        }, 1000);
      }).onDisconnect(() => setConnected(false)).build();

    const syncPlayers = () => setPlayers([...conn.db.player.iter()].filter((player) => player.role === "controller"));
    conn.db.player.onInsert(syncPlayers);
    conn.db.player.onUpdate(syncPlayers);
    conn.db.player.onDelete(syncPlayers);
    const updateRtt = (ctx, row) => {
      if (row.identity.isEqual(conn.identity) && conn._lastPingSentAt) setRtt(Date.now() - conn._lastPingSentAt);
    };
    conn.db.pingLog.onInsert(updateRtt);
    conn.db.pingLog.onUpdate((ctx, oldRow, newRow) => updateRtt(ctx, newRow));
    return () => { clearInterval(pingInterval); conn.disconnect(); };
  }, []);

  return <Display mode="cloud" connected={connected} rtt={rtt} players={players} />;
}

function LanPlay() {
  const socketRef = useRef(null);
  const retryRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [rtt, setRtt] = useState(null);
  const [players, setPlayers] = useState([]);
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
        socket.send(JSON.stringify({ type: "hello", role: "display" }));
        pingInterval = setInterval(() => socket.send(JSON.stringify({ type: "ping", sentAt: Date.now() })), 1000);
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "state") setPlayers(message.players);
        if (message.type === "pong") setRtt(Date.now() - message.sentAt);
      };
      socket.onclose = () => {
        setConnected(false);
        setPlayers([]);
        clearInterval(pingInterval);
        if (!stopped) retryRef.current = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => { stopped = true; clearInterval(pingInterval); clearTimeout(retryRef.current); socketRef.current?.close(); };
  }, []);

  return <Display mode="lan" connected={connected} rtt={rtt} players={players} serverUrl={serverUrl} />;
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

function DirectPlay() {
  const peerRef = useRef(null);
  const channelRef = useRef(null);
  const inputRef = useRef({ x: 0, y: 0 });
  const positionRef = useRef({ x: 0, y: 0 });
  const [offer, setOffer] = useState("");
  const [answer, setAnswer] = useState("");
  const [connected, setConnected] = useState(false);
  const [rtt, setRtt] = useState(null);
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    let movementInterval;
    let pingInterval;
    const peer = new RTCPeerConnection({ iceServers: [] });
    peerRef.current = peer;
    const channel = peer.createDataChannel("controller");
    channelRef.current = channel;
    channel.onopen = () => {
      setConnected(true);
      let previous = performance.now();
      movementInterval = setInterval(() => {
        const now = performance.now();
        const seconds = Math.min((now - previous) / 1000, 0.1);
        previous = now;
        positionRef.current.x += inputRef.current.x * 180 * seconds;
        positionRef.current.y += inputRef.current.y * 180 * seconds;
        setPlayers([{ id: "direct", ...positionRef.current }]);
      }, 50);
      pingInterval = setInterval(() => channel.send(JSON.stringify({ type: "ping", sentAt: Date.now() })), 1000);
    };
    channel.onclose = () => setConnected(false);
    channel.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "input" && Number.isFinite(message.x) && Number.isFinite(message.y)) {
        const magnitude = Math.hypot(message.x, message.y);
        const scale = magnitude > 1 ? 1 / magnitude : 1;
        inputRef.current = { x: message.x * scale, y: message.y * scale };
      }
      if (message.type === "pong") setRtt(Date.now() - message.sentAt);
    };

    (async () => {
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer);
      setOffer(encodeSignal(peer.localDescription));
    })();

    return () => {
      clearInterval(movementInterval);
      clearInterval(pingInterval);
      peer.close();
    };
  }, []);

  async function acceptAnswer() {
    try {
      await peerRef.current.setRemoteDescription(decodeSignal(answer.trim()));
    } catch (error) {
      alert(`Could not accept answer: ${error.message}`);
    }
  }

  return <>
    <Display mode="direct" connected={connected} rtt={rtt} players={players} />
    {!connected && <div style={{ position: "fixed", left: 12, right: 12, bottom: 12, background: "#222", color: "#fff", padding: 12, fontFamily: "monospace" }}>
      <strong>Direct WebRTC pairing</strong>
      <p>1. Copy this offer to the phone&apos;s Direct controller.</p>
      <textarea readOnly value={offer || "Gathering local connection details..."} rows={3} style={{ width: "100%", boxSizing: "border-box" }} />
      <button onClick={() => navigator.clipboard.writeText(offer)} disabled={!offer}>Copy offer</button>
      <p>2. Paste the answer returned by the phone.</p>
      <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={3} style={{ width: "100%", boxSizing: "border-box" }} />
      <button onClick={acceptAnswer} disabled={!answer.trim()}>Connect</button>
    </div>}
  </>;
}

export default function Play() {
  const router = useRouter();
  if (router.query.mode === "direct") return <DirectPlay />;
  if (router.query.mode === "lan") return <LanPlay />;
  return <CloudPlay />;
}
