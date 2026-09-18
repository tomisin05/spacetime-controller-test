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
