import { useEffect, useRef, useState } from "react";
import { Timestamp } from "spacetimedb";
import { DbConnection } from "../module_bindings";

// Public deployment settings can be overridden in web/.env.local.
const SPACETIME_URI =
  process.env.NEXT_PUBLIC_SPACETIME_URI || "wss://maincloud.spacetimedb.com";
const MODULE_NAME =
  process.env.NEXT_PUBLIC_SPACETIME_MODULE || "test-hop-hacks-dfa4f";

export default function Play() {
  const canvasRef = useRef(null);
  const [rtt, setRtt] = useState(null);
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    let pingInterval;
    const conn = DbConnection.builder()
      .withUri(SPACETIME_URI)
      .withDatabaseName(MODULE_NAME)
      .onConnect((c) => {
        c.reducers.registerAsDisplay({});
        c.subscriptionBuilder()
          .onApplied(() => console.log("subscribed"))
          .subscribe(["SELECT * FROM player", "SELECT * FROM ping_log"]);

        // periodic RTT ping
        pingInterval = setInterval(() => {
          const sentAt = Date.now();
          c._lastPingSentAt = sentAt;
          c.reducers.ping({ clientSentAt: Timestamp.fromDate(new Date(sentAt)) });
        }, 1000);
      })
      .build();

    conn.db.player.onInsert(() => syncPlayers(conn));
    conn.db.player.onUpdate(() => syncPlayers(conn));
    conn.db.player.onDelete(() => syncPlayers(conn));

    const updateRtt = (ctx, row) => {
      if (row.identity.isEqual(conn.identity) && conn._lastPingSentAt) {
        const rttMs = Date.now() - conn._lastPingSentAt;
        setRtt(rttMs);
      }
    };
    conn.db.pingLog.onInsert(updateRtt);
    conn.db.pingLog.onUpdate((ctx, oldRow, newRow) => updateRtt(ctx, newRow));

    return () => {
      clearInterval(pingInterval);
      conn.disconnect();
    };
  }, []);

  function syncPlayers(conn) {
    const all = [...conn.db.player.iter()];
    setPlayers(all);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      players
        .filter((p) => p.role === "controller")
        .forEach((p, i) => {
          ctx.fillStyle = `hsl(${i * 90}, 80%, 60%)`;
          ctx.beginPath();
          ctx.arc(
            canvas.width / 2 + p.x,
            canvas.height / 2 + p.y,
            12,
            0,
            Math.PI * 2
          );
          ctx.fill();
        });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [players]);

  return (
    <div style={{ background: "#000", minHeight: "100vh", color: "#fff", fontFamily: "monospace" }}>
      <div style={{ padding: 12 }}>
        <strong>Display</strong> — RTT to server: {rtt !== null ? `${rtt} ms` : "measuring..."}
        <br />
        Connected controllers: {players.filter((p) => p.role === "controller").length}
      </div>
      <canvas ref={canvasRef} width={600} height={600} style={{ display: "block", margin: "0 auto" }} />
    </div>
  );
}
