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

  const controllerHref = mode === "lan" ? "/controller?mode=lan" : "/controller?mode=cloud";
  return <div style={{ background: "#000", minHeight: "100vh", color: "#fff", fontFamily: "monospace" }}>
    <div style={{ padding: 12 }}>
      <strong>{mode === "lan" ? "LAN Display" : "Maincloud Display"}</strong> — {connected ? "connected" : "connecting..."}{rtt !== null && ` — RTT: ${rtt} ms`}
      <br />Connected controllers: {players.length}
      {serverUrl && <><br />Server: {serverUrl}</>}
      <br /><a href={controllerHref} style={{ color: "#6cf" }}>Open matching controller</a>
      <span> · </span><a href={mode === "lan" ? "/play?mode=cloud" : "/play?mode=lan"} style={{ color: "#6f6" }}>Switch to {mode === "lan" ? "Cloud" : "LAN"}</a>
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

export default function Play() {
  const router = useRouter();
  return router.query.mode === "lan" ? <LanPlay /> : <CloudPlay />;
}
