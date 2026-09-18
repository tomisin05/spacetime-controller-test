import { useEffect, useRef, useState } from "react";
import { Timestamp } from "spacetimedb";
import { DbConnection } from "../module_bindings";

const SPACETIME_URI =
  process.env.NEXT_PUBLIC_SPACETIME_URI || "wss://maincloud.spacetimedb.com";
const MODULE_NAME =
  process.env.NEXT_PUBLIC_SPACETIME_MODULE || "test-hop-hacks-dfa4f";

export default function Controller() {
  const connRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [rtt, setRtt] = useState(null);
  const joyRef = useRef(null);
  const dragging = useRef(false);
  const currentInput = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let pingInterval;
    let inputInterval;
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(MODULE_NAME)
      .onConnect((c) => {
        setConnected(true);
        c.subscriptionBuilder().subscribe(["SELECT * FROM ping_log"]);
        pingInterval = setInterval(() => {
          const sentAt = Date.now();
          c._lastPingSentAt = sentAt;
          c.reducers.ping({ clientSentAt: Timestamp.fromDate(new Date(sentAt)) });
        }, 1000);
        inputInterval = setInterval(() => {
          const { x, y } = currentInput.current;
          if (dragging.current) c.reducers.sendInput({ inputX: x, inputY: y });
        }, 50);
      })
      .onDisconnect(() => setConnected(false))
      .build();
    connRef.current = conn;

    const updateRtt = (ctx, row) => {
      if (row.identity.isEqual(conn.identity) && conn._lastPingSentAt) {
        setRtt(Date.now() - conn._lastPingSentAt);
      }
    };
    conn.db.pingLog.onInsert(updateRtt);
    conn.db.pingLog.onUpdate((ctx, oldRow, newRow) => updateRtt(ctx, newRow));

    return () => {
      clearInterval(pingInterval);
      clearInterval(inputInterval);
      conn.disconnect();
    };
  }, []);

  function sendInput(x, y) {
    currentInput.current = { x, y };
    connRef.current?.reducers.sendInput({ inputX: x, inputY: y });
  }

  function handlePointer(e) {
    if (!dragging.current) return;
    const rect = joyRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const px = e.clientX;
    const py = e.clientY;
    let dx = (px - cx) / (rect.width / 2);
    let dy = (py - cy) / (rect.height / 2);
    const mag = Math.min(1, Math.hypot(dx, dy));
    const angle = Math.atan2(dy, dx);
    dx = Math.cos(angle) * mag;
    dy = Math.sin(angle) * mag;
    sendInput(dx, dy);
  }

  function startPointer(e) {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    handlePointer(e);
  }

  function stopPointer(e) {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    sendInput(0, 0);
  }

  return (
    <div
      style={{
        background: "#000",
        minHeight: "100vh",
        color: "#fff",
        fontFamily: "monospace",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "none",
      }}
    >
      <div style={{ marginBottom: 24 }}>
        {connected ? "Connected to SpacetimeDB" : "Connecting..."}
        {rtt !== null && ` — RTT: ${rtt}ms`}
      </div>
      <div
        ref={joyRef}
        onPointerDown={startPointer}
        onPointerUp={stopPointer}
        onPointerCancel={stopPointer}
        onPointerMove={handlePointer}
        style={{
          width: 220,
          height: 220,
          borderRadius: "50%",
          border: "2px solid #444",
          background: "#111",
        }}
      />
    </div>
  );
}
