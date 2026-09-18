use spacetimedb::{table, reducer, Table, ReducerContext, Identity, Timestamp};

// One row per connected client (phone controller OR display)
#[table(name = player, public)]
pub struct Player {
    #[primary_key]
    identity: Identity,
    x: f32,
    y: f32,
    last_input_x: f32,
    last_input_y: f32,
    last_update: Timestamp,
    role: String, // "controller" or "display"
}

// One row per client, updated in place, so RTT probes do not grow the table.
#[table(name = ping_log, public)]
pub struct PingLog {
    #[primary_key]
    identity: Identity,
    client_sent_at: Timestamp,
    server_received_at: Timestamp,
}

#[reducer(client_connected)]
pub fn identity_connected(ctx: &ReducerContext) {
    ctx.db.player().insert(Player {
        identity: ctx.sender,
        x: 0.0,
        y: 0.0,
        last_input_x: 0.0,
        last_input_y: 0.0,
        last_update: ctx.timestamp,
        role: "unknown".to_string(),
    });
}

#[reducer(client_disconnected)]
pub fn identity_disconnected(ctx: &ReducerContext) {
    if ctx.db.player().identity().find(ctx.sender).is_some() {
        ctx.db.player().identity().delete(ctx.sender);
    }
    if ctx.db.ping_log().identity().find(ctx.sender).is_some() {
        ctx.db.ping_log().identity().delete(ctx.sender);
    }
}

// Called by the phone /controller page on every joystick/button update
#[reducer]
pub fn send_input(ctx: &ReducerContext, input_x: f32, input_y: f32) {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender) {
        if !input_x.is_finite() || !input_y.is_finite() {
            return;
        }
        let magnitude = (input_x * input_x + input_y * input_y).sqrt();
        let scale = if magnitude > 1.0 { 1.0 / magnitude } else { 1.0 };
        let input_x = input_x * scale;
        let input_y = input_y * scale;

        // Use elapsed server time, not browser event frequency, and cap stalls.
        let elapsed = ctx
            .timestamp
            .duration_since(p.last_update)
            .map(|duration| duration.as_secs_f32().min(0.1))
            .unwrap_or(0.0);
        const SPEED: f32 = 180.0;

        p.last_input_x = input_x;
        p.last_input_y = input_y;
        p.x += input_x * SPEED * elapsed;
        p.y += input_y * SPEED * elapsed;
        p.last_update = ctx.timestamp;
        p.role = "controller".to_string();
        ctx.db.player().identity().update(p);
    }
}

// Called once by the /play display page to tag its own row
#[reducer]
pub fn register_as_display(ctx: &ReducerContext) {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender) {
        p.role = "display".to_string();
        ctx.db.player().identity().update(p);
    }
}

// RTT measurement: client calls this with its own send timestamp,
// server logs when it was actually received. Client compares against
// the row it gets back via subscription to compute one-way + RTT.
#[reducer]
pub fn ping(ctx: &ReducerContext, client_sent_at: Timestamp) {
    let ping = PingLog {
        identity: ctx.sender,
        client_sent_at,
        server_received_at: ctx.timestamp,
    };
    if ctx.db.ping_log().identity().find(ctx.sender).is_some() {
        ctx.db.ping_log().identity().update(ping);
    } else {
        ctx.db.ping_log().insert(ping);
    }
}
