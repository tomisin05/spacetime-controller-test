# SpacetimeDB Controller Test

Minimal test rig for your notes: phone = controller, laptop = display,
SpacetimeDB = authoritative server, both frontend routes deployed on Vercel.

## 1. Publish the SpacetimeDB module

You'll need the `spacetime` CLI locally and a SpacetimeDB account.

```bash
curl -sSf https://install.spacetimedb.com | sh
spacetime login
spacetime publish --module-path server test-hop-hacks-dfa4f
```

This gives you a module name/address on `maincloud.spacetimedb.com`
(or your own self-hosted instance if you run `spacetime start` locally first).

## 2. Generate the TypeScript client bindings

```bash
spacetime generate --lang typescript --out-dir web/module_bindings --module-path server
```

This creates `web/module_bindings/` with the `DbConnection` class and typed
reducers (`sendInput`, `ping`, `registerAsDisplay`) that `play.js` and
`controller.js` import.

## 3. Set the module name

Copy the example environment file and set the values to match your deployment:

```bash
cd web
cp .env.example .env.local
```

`NEXT_PUBLIC_SPACETIME_MODULE` must match the name used with
`spacetime publish`. The defaults already target `maincloud.spacetimedb.com`
and the `test-hop-hacks-dfa4f` module.

## 4. Deploy the web app to Vercel

```bash
cd web
npm install
vercel deploy
```

No WebSocket config needed on Vercel's side — the browser connects
*directly* to SpacetimeDB over `wss://`, bypassing Vercel's serverless
functions entirely. Vercel only ever serves the static/SSR pages.

## 5. Test

- Open `/play` on your laptop
- Open `/controller` on your phone (same or different network — SpacetimeDB
  handles the relay, so LAN isn't required)
- Drag the joystick — the dot should move on the laptop screen
- Both pages show live RTT to the SpacetimeDB server, refreshed every second

## LAN mode

LAN mode keeps all traffic on the local network. Start the web app and the
authoritative WebSocket server in separate terminals:

```bash
cd web
npm run dev:lan
```

```bash
cd web
npm run lan-server
```

Find the laptop's IPv4 address with `ipconfig`, then open
`http://<laptop-ip>:3000/controller?mode=lan` on a phone connected to the same
Wi-Fi. Open `http://localhost:3000/play?mode=lan` on the laptop. Allow TCP ports
3000 and 8787 through the laptop firewall when prompted.

LAN mode is intended for locally served HTTP pages. An HTTPS Vercel page will
normally be blocked from connecting to an insecure local `ws://` endpoint.

## Direct WebRTC mode

Direct mode uses SpacetimeDB only for short-lived pairing. After pairing,
controller commands travel browser-to-browser over WebRTC without passing
through SpacetimeDB, a local Node server, or another database:

1. Open `/play?mode=direct` on the laptop.
2. Scan the displayed QR code with the phone, or open
   `/controller?mode=direct` and enter the six-digit room code.
3. The devices exchange their WebRTC offer and answer automatically.
4. The temporary signaling room is deleted once paired.

Both devices should be on the same Wi-Fi. Maincloud mode remains the fallback
for networks where direct peer connectivity is restricted.

### Use the local server from Vercel

For testing without a domain or Cloudflare account, expose the WebSocket server
through a temporary Cloudflare Quick Tunnel:

Install `cloudflared` once on Windows (approve the installer prompt if shown):

```powershell
winget install --id Cloudflare.cloudflared
```

```bash
cd web
npm run lan-server
```

In a second terminal:

```bash
cd web
npm run lan:tunnel
```

Copy the generated `https://...trycloudflare.com` URL and change its scheme to
`wss://`. Then open the Vercel display with it as the `server` query parameter:

```text
https://YOUR-VERCEL-SITE/play?mode=lan&server=wss%3A%2F%2FYOUR-TUNNEL.trycloudflare.com
```

The display's **Open or copy matching controller link** preserves that server
address. Share that link with the phone. Quick Tunnel addresses change whenever
the tunnel restarts; a stable address requires a named Cloudflare Tunnel and a
domain managed in Cloudflare.

## What this validates from your notes

- **Input delay based on server↔local RTT**: both pages ping every second and
  display live RTT; you can extend `send_input` to buffer/delay input by
  `rtt/2` once you've got a baseline reading.
- **Authoritative server**: time-based position updates happen in the reducer,
  server-side — clients never touch position directly, only send intent
  (`input_x`, `input_y`).
- **Vercel + realtime**: confirms the split from your Vercel box in the
  sketch — Vercel serves `/play` and `/controller`, SpacetimeDB is the box
  those arrows point into.

## Known simplifications to extend later

- No auth beyond SpacetimeDB's identity system
- Positions are raw server snapshots; add interpolation/reconciliation before
  using this as a production game controller.
