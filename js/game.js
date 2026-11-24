"use strict";

/*
    DeadPol R34 - top-down traffic dodging game.

    File map:
      1. Canvas and constants
      2. Game state
      3. Input
      4. Game flow (start, pause, game over, restart)
      5. Update (player, traffic, collisions, score)
      6. Drawing
      7. Game loop
*/

/* ==========================================================
   1. Canvas and constants
   ========================================================== */

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// The game always works in a 400 x 700 "virtual" screen.
// CSS decides how big it looks; these numbers never change.
const VIEW_WIDTH = 400;
const VIEW_HEIGHT = 700;

const ROAD_LEFT = 50;
const ROAD_WIDTH = 300;
const ROAD_EDGE_WIDTH = 6;
const LANE_COUNT = 3;
const LANE_WIDTH = ROAD_WIDTH / LANE_COUNT;
const LANE_DASH_HEIGHT = 45;
const LANE_DASH_GAP = 35;

const PLAYER_WIDTH = 50;
const PLAYER_HEIGHT = 90;
const PLAYER_STEER_SPEED = 340;      // pixels per second, sideways

// All speeds are in pixels per second, so they do not depend on the
// monitor refresh rate.
const START_ROAD_SPEED = 320;
const MAX_ROAD_SPEED = 640;
const ROAD_ACCELERATION = 6;         // extra px/s gained every second
const IDLE_ROAD_SPEED = 110;         // slow scroll behind the start screen

// Traffic drives in the same direction as the player, only slower,
// so on screen it comes down at a fraction of the road speed.
const TRAFFIC_SPEED_FACTOR = 0.6;

// Seconds of empty road the player gets between two rows of traffic.
const START_CLEAR_TIME = 1.25;
const MIN_CLEAR_TIME = 0.8;
const FIRST_WAVE_DISTANCE = 250;

const PIXELS_PER_METER = 12;

// Longest time step the game will simulate in one frame (seconds).
const MAX_FRAME_TIME = 0.05;

// Short wait before Enter/Space can restart, so a key that is already
// held down at the moment of the crash does not skip the Game Over screen.
const RESTART_DELAY_MS = 400;

const BEST_SCORE_KEY = "deadpol-r34-best-score";

// Hitboxes are a little smaller than the drawing (rounded corners,
// mirrors), which makes close calls feel fair.
const PLAYER_HITBOX_INSET_X = 5;
const PLAYER_HITBOX_INSET_Y = 6;
const TRAFFIC_HITBOX_INSET = 3;

const VEHICLE_TYPES = {
    car: {
        width: 50,
        height: 90,
        colors: ["#dc2626", "#f59e0b", "#e5e7eb", "#16a34a", "#9333ea"]
    },
    van: {
        width: 54,
        height: 106,
        colors: ["#f8fafc", "#fbbf24", "#14b8a6"]
    },
    truck: {
        width: 58,
        height: 136,
        colors: ["#b91c1c", "#0f766e", "#c2410c"]
    }
};

// Repeated names make that vehicle more common.
const VEHICLE_MIX = ["car", "car", "car", "van", "van", "truck"];

const hud = {
    score: document.getElementById("scoreValue"),
    speed: document.getElementById("speedValue"),
    best: document.getElementById("bestValue"),
    finalScore: document.getElementById("finalScoreValue"),
    finalBest: document.getElementById("finalBestValue"),
    newBestBadge: document.getElementById("newBestBadge")
};

const steerButtons = {
    left: document.getElementById("steerLeft"),
    right: document.getElementById("steerRight")
};

const screens = {
    start: document.getElementById("startScreen"),
    pause: document.getElementById("pauseScreen"),
    gameOver: document.getElementById("gameOverScreen")
};

/* ==========================================================
   2. Game state
   ========================================================== */

const game = {
    state: "start",          // "start" | "playing" | "gameover"
    paused: false,
    elapsed: 0,              // seconds played in this round
    distance: 0,             // pixels driven in this round
    roadSpeed: 0,
    roadScroll: 0,           // total scroll, used to animate the road
    score: 0,
    best: loadBestScore(),
    safeLane: 1,             // lane the next wave must leave empty
    nextWaveIn: 0,           // pixels of traffic travel until the next wave
    gameOverAt: 0,
    crashFlash: 0
};

const player = {
    x: 0,
    y: VIEW_HEIGHT - PLAYER_HEIGHT - 30,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    tilt: 0                  // small rotation while steering (visual only)
};

let traffic = [];

const keys = {
    left: false,
    right: false
};

// On-screen steering buttons. Kept apart from "keys" so that releasing
// a key cannot cancel a held button, or the other way round.
const touch = {
    left: false,
    right: false
};

// Which finger (pointer id) is holding each button, or null.
const touchPointers = {
    left: null,
    right: null
};

/* ==========================================================
   3. Input
   ========================================================== */

// Pointer events cover fingers, pens and the mouse with the same code.
function setupSteerButton(direction) {
    const button = steerButtons[direction];

    button.addEventListener("pointerdown", (event) => {
        const canSteer = game.state === "playing" && !game.paused;

        // Ignore right clicks and a second finger on the same button.
        if (!canSteer || event.button !== 0 || touchPointers[direction] !== null) {
            return;
        }

        event.preventDefault();

        touchPointers[direction] = event.pointerId;
        touch[direction] = true;
        button.classList.add("is-held");

        // Capture: the button keeps receiving this finger's events even
        // if it slides off the button, so the release is never missed.
        try {
            button.setPointerCapture(event.pointerId);
        } catch (error) {
            // Steering still works without capture.
        }
    });

    // Finger lifted, touch cancelled by the system (a call, a gesture),
    // or capture lost: all three mean "stop steering".
    const release = (event) => {
        if (event.pointerId === touchPointers[direction]) {
            releaseSteer(direction);
        }
    };

    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);

    // A long press must not open the browser's context menu.
    button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
    });
}

function releaseSteer(direction) {
    const button = steerButtons[direction];
    const pointerId = touchPointers[direction];

    touch[direction] = false;
    touchPointers[direction] = null;
    button.classList.remove("is-held");

    if (pointerId !== null && button.hasPointerCapture(pointerId)) {
        button.releasePointerCapture(pointerId);
    }
}

// Forgets every held key and button. Called whenever the round stops or
// starts (pause, focus loss, crash, restart), because the matching
// "key up" or "finger up" event may never arrive in those moments.
function clearHeldInput() {
    keys.left = false;
    keys.right = false;

    releaseSteer("left");
    releaseSteer("right");
}

// The steering buttons only work during a round that is not paused.
function updateSteerButtons() {
    const canSteer = game.state === "playing" && !game.paused;

    steerButtons.left.disabled = !canSteer;
    steerButtons.right.disabled = !canSteer;
}

setupSteerButton("left");
setupSteerButton("right");

window.addEventListener("keydown", (event) => {
    if (event.code === "ArrowLeft" || event.code === "KeyA") {
        keys.left = true;
        event.preventDefault();
        return;
    }

    if (event.code === "ArrowRight" || event.code === "KeyD") {
        keys.right = true;
        event.preventDefault();
        return;
    }

    // A held key repeats "keydown"; the actions below must fire once.
    if (event.repeat) {
        return;
    }

    const isConfirmKey =
        event.code === "Enter" ||
        event.code === "NumpadEnter" ||
        event.code === "Space";

    if (isConfirmKey) {
        event.preventDefault();

        if (game.state === "start") {
            startGame();
        } else if (game.state === "playing" && game.paused) {
            setPaused(false);
        } else if (
            game.state === "gameover" &&
            performance.now() - game.gameOverAt >= RESTART_DELAY_MS
        ) {
            startGame();
        }

        return;
    }

    if (event.code === "KeyP" || event.code === "Escape") {
        if (game.state === "playing") {
            setPaused(!game.paused);
        }
    }
});

window.addEventListener("keyup", (event) => {
    if (event.code === "ArrowLeft" || event.code === "KeyA") {
        keys.left = false;
    }

    if (event.code === "ArrowRight" || event.code === "KeyD") {
        keys.right = false;
    }
});

// When the window loses focus the browser never sends "keyup", so a key
// would stay "pressed" forever. Release everything and pause the round.
function handleFocusLoss() {
    clearHeldInput();

    if (game.state === "playing") {
        setPaused(true);
    }
}

window.addEventListener("blur", handleFocusLoss);

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        handleFocusLoss();
    }

    // Forget the last frame time so the time spent in the background
    // is not counted as one huge step when the tab comes back.
    lastFrameTime = null;
});

document.getElementById("startButton").addEventListener("click", startGame);
document.getElementById("restartButton").addEventListener("click", startGame);
document.getElementById("resumeButton").addEventListener("click", () => {
    setPaused(false);
});

/* ==========================================================
   4. Game flow
   ========================================================== */

// Starts a round. It is also the restart: it only resets data.
// The animation loop is started once at the bottom of this file and is
// never started again, so restarting cannot create a second loop.
function startGame() {
    game.state = "playing";
    game.paused = false;
    game.elapsed = 0;
    game.distance = 0;
    game.roadSpeed = START_ROAD_SPEED;
    game.score = 0;
    game.safeLane = 1;
    game.nextWaveIn = FIRST_WAVE_DISTANCE;
    game.crashFlash = 0;

    traffic = [];

    player.x = VIEW_WIDTH / 2 - player.width / 2;
    player.tilt = 0;

    clearHeldInput();
    lastFrameTime = null;

    showScreen(null);
    updateHud();
}

function setPaused(paused) {
    game.paused = paused;
    clearHeldInput();
    lastFrameTime = null;
    showScreen(paused ? "pause" : null);
}

function endGame() {
    game.state = "gameover";
    game.paused = false;
    game.gameOverAt = performance.now();
    game.crashFlash = 1;
    clearHeldInput();

    const isNewBest = game.score > game.best;

    if (isNewBest) {
        game.best = game.score;
        saveBestScore(game.best);
    }

    hud.finalScore.textContent = game.score;
    hud.finalBest.textContent = game.best;
    hud.newBestBadge.hidden = !isNewBest;

    updateHud();
    showScreen("gameOver");
}

// Shows one overlay ("start", "pause", "gameOver") or none (null).
function showScreen(name) {
    for (const key in screens) {
        screens[key].hidden = key !== name;
    }

    // Every change of state goes through here, so this is the one place
    // that switches the steering buttons on and off.
    updateSteerButtons();
}

// localStorage can be blocked (private mode, file:// rules), so the game
// must keep working without it.
function loadBestScore() {
    try {
        const saved = Number(localStorage.getItem(BEST_SCORE_KEY));
        return Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 0;
    } catch (error) {
        return 0;
    }
}

function saveBestScore(value) {
    try {
        localStorage.setItem(BEST_SCORE_KEY, String(value));
    } catch (error) {
        // The best score simply lasts until the page is closed.
    }
}

function updateHud() {
    const speedKmh = Math.round(game.roadSpeed / PIXELS_PER_METER * 3.6);

    setText(hud.score, game.score);
    setText(hud.speed, game.state === "playing" ? speedKmh : 0);
    setText(hud.best, game.best);
}

// Only touches the page when the value really changed.
function setText(element, value) {
    const text = String(value);

    if (element.textContent !== text) {
        element.textContent = text;
    }
}

/* ==========================================================
   5. Update
   ========================================================== */

// "dt" is the time since the previous frame, in seconds.
// Every movement is "speed * dt", so a 60 Hz and a 144 Hz monitor
// cover the same distance in the same real time.
function update(dt) {
    if (game.state === "start") {
        game.roadScroll += IDLE_ROAD_SPEED * dt;
        return;
    }

    if (game.state === "gameover") {
        game.crashFlash = Math.max(0, game.crashFlash - dt * 2.5);
        return;
    }

    if (game.paused) {
        return;
    }

    game.elapsed += dt;
    game.roadSpeed = Math.min(
        MAX_ROAD_SPEED,
        START_ROAD_SPEED + ROAD_ACCELERATION * game.elapsed
    );

    const roadStep = game.roadSpeed * dt;
    game.roadScroll += roadStep;
    game.distance += roadStep;
    game.score = Math.floor(game.distance / PIXELS_PER_METER);

    updatePlayer(dt);
    updateTraffic(dt);

    if (playerHitsTraffic()) {
        endGame();
        return;
    }

    updateHud();
}

function updatePlayer(dt) {
    let direction = 0;

    // Keyboard and touch buttons steer the same way; holding both
    // directions at once cancels out.
    if (keys.left || touch.left) {
        direction -= 1;
    }

    if (keys.right || touch.right) {
        direction += 1;
    }

    const previousX = player.x;
    const minimumX = ROAD_LEFT + ROAD_EDGE_WIDTH;
    const maximumX =
        ROAD_LEFT + ROAD_WIDTH - ROAD_EDGE_WIDTH - player.width;

    player.x += direction * PLAYER_STEER_SPEED * dt;
    player.x = Math.min(maximumX, Math.max(minimumX, player.x));

    // Lean into the turn, but only while the car is really moving sideways.
    const targetTilt = player.x !== previousX ? direction * 0.07 : 0;
    player.tilt += (targetTilt - player.tilt) * Math.min(1, dt * 12);
}

function updateTraffic(dt) {
    const step = game.roadSpeed * TRAFFIC_SPEED_FACTOR * dt;

    for (const vehicle of traffic) {
        vehicle.y += step;
    }

    traffic = traffic.filter((vehicle) => vehicle.y < VIEW_HEIGHT);

    // Waves are spaced by distance travelled, not by frames.
    game.nextWaveIn -= step;

    if (game.nextWaveIn <= 0) {
        // The wave was due a few pixels ago; start it that much lower
        // so the spacing is exact at any frame rate.
        const overshoot = -game.nextWaveIn;
        const waveLength = spawnWave(overshoot);

        // Gap = the wave itself + room for the player's car + the
        // distance traffic covers during the "clear time".
        game.nextWaveIn +=
            waveLength +
            player.height +
            game.roadSpeed * TRAFFIC_SPEED_FACTOR * currentClearTime();
    }
}

function currentClearTime() {
    return Math.max(
        MIN_CLEAR_TIME,
        START_CLEAR_TIME - game.elapsed * 0.006
    );
}

// Creates one row of traffic and returns the length of its longest vehicle.
//
// Fairness rules:
//   - A wave blocks one or two lanes, never all three.
//   - One lane (the "safe lane") is always left empty, and it moves at
//     most one lane between consecutive waves, so the player never has
//     to cross the whole road in a single gap.
//   - All traffic moves at the same speed, so gaps never close.
function spawnWave(overshoot) {
    const shift = randomInt(-1, 1);
    game.safeLane = Math.min(
        LANE_COUNT - 1,
        Math.max(0, game.safeLane + shift)
    );

    const blockableLanes = [];

    for (let lane = 0; lane < LANE_COUNT; lane++) {
        if (lane !== game.safeLane) {
            blockableLanes.push(lane);
        }
    }

    // More double waves as the round goes on.
    const doubleChance = Math.min(0.6, 0.25 + game.elapsed * 0.006);
    const lanes = Math.random() < doubleChance
        ? blockableLanes
        : [pickRandom(blockableLanes)];

    let waveLength = 0;

    for (const lane of lanes) {
        const kind = pickRandom(VEHICLE_MIX);
        const type = VEHICLE_TYPES[kind];
        const laneCenter = ROAD_LEFT + LANE_WIDTH * lane + LANE_WIDTH / 2;

        traffic.push({
            kind: kind,
            lane: lane,
            x: laneCenter - type.width / 2,
            y: -type.height + overshoot,
            width: type.width,
            height: type.height,
            color: pickRandom(type.colors)
        });

        waveLength = Math.max(waveLength, type.height);
    }

    return waveLength;
}

function randomInt(minimum, maximum) {
    return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
}

// Collision box of a vehicle, shrunk by the given margins.
function getHitbox(vehicle, insetX, insetY) {
    return {
        left: vehicle.x + insetX,
        right: vehicle.x + vehicle.width - insetX,
        top: vehicle.y + insetY,
        bottom: vehicle.y + vehicle.height - insetY
    };
}

// Two rectangles overlap when they overlap on both axes at once.
function boxesOverlap(a, b) {
    return (
        a.left < b.right &&
        a.right > b.left &&
        a.top < b.bottom &&
        a.bottom > b.top
    );
}

function playerHitsTraffic() {
    const playerBox = getHitbox(
        player,
        PLAYER_HITBOX_INSET_X,
        PLAYER_HITBOX_INSET_Y
    );

    for (const vehicle of traffic) {
        const vehicleBox = getHitbox(
            vehicle,
            TRAFFIC_HITBOX_INSET,
            TRAFFIC_HITBOX_INSET
        );

        if (boxesOverlap(playerBox, vehicleBox)) {
            return true;
        }
    }

    return false;
}

/* ==========================================================
   6. Drawing
   ========================================================== */

// Sharp picture on high-density screens: the canvas gets more real
// pixels, and the scale lets the game keep drawing in 400 x 700 units.
function setupCanvas() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = VIEW_WIDTH * pixelRatio;
    canvas.height = VIEW_HEIGHT * pixelRatio;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function roundedRect(x, y, width, height, radius) {
    ctx.beginPath();

    if (ctx.roundRect) {
        ctx.roundRect(x, y, width, height, radius);
    } else {
        ctx.rect(x, y, width, height);
    }

    ctx.fill();
}

function drawPolygon(points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);

    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
    }

    ctx.closePath();
    ctx.fill();
}

function drawCircle(x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
}

function drawRoad() {
    const roadRight = ROAD_LEFT + ROAD_WIDTH;

    // Grass with darker bands that scroll, to give a sense of speed.
    const bandPeriod = 140;
    const bandOffset = game.roadScroll % bandPeriod;

    ctx.fillStyle = "#1f4d2b";
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

    ctx.fillStyle = "#235631";

    for (let y = bandOffset - bandPeriod; y < VIEW_HEIGHT; y += bandPeriod) {
        ctx.fillRect(0, y, ROAD_LEFT, bandPeriod / 2);
        ctx.fillRect(roadRight, y, VIEW_WIDTH - roadRight, bandPeriod / 2);
    }

    // Asphalt.
    ctx.fillStyle = "#33363d";
    ctx.fillRect(ROAD_LEFT, 0, ROAD_WIDTH, VIEW_HEIGHT);

    // Red and white kerbs on both edges.
    const kerbPeriod = 40;
    const kerbOffset = game.roadScroll % kerbPeriod;

    ctx.fillStyle = "#f1f5f9";
    ctx.fillRect(ROAD_LEFT, 0, ROAD_EDGE_WIDTH, VIEW_HEIGHT);
    ctx.fillRect(
        roadRight - ROAD_EDGE_WIDTH,
        0,
        ROAD_EDGE_WIDTH,
        VIEW_HEIGHT
    );

    ctx.fillStyle = "#dc2626";

    for (let y = kerbOffset - kerbPeriod; y < VIEW_HEIGHT; y += kerbPeriod) {
        ctx.fillRect(ROAD_LEFT, y, ROAD_EDGE_WIDTH, kerbPeriod / 2);
        ctx.fillRect(
            roadRight - ROAD_EDGE_WIDTH,
            y,
            ROAD_EDGE_WIDTH,
            kerbPeriod / 2
        );
    }

    // Dashed lane lines.
    const dashPeriod = LANE_DASH_HEIGHT + LANE_DASH_GAP;
    const dashOffset = game.roadScroll % dashPeriod;

    ctx.fillStyle = "#d4d4d8";

    for (let y = dashOffset - dashPeriod; y < VIEW_HEIGHT; y += dashPeriod) {
        for (let lane = 1; lane < LANE_COUNT; lane++) {
            ctx.fillRect(
                ROAD_LEFT + LANE_WIDTH * lane - 2,
                y,
                4,
                LANE_DASH_HEIGHT
            );
        }
    }
}

// Original top-down coupe inspired by the R34 silhouette: boxy body,
// long bonnet, tall rear wing and four round tail lights.
// It is drawn around its own centre so it can lean while steering.
function drawPlayer() {
    const halfWidth = player.width / 2;
    const halfHeight = player.height / 2;

    ctx.save();
    ctx.translate(player.x + halfWidth, player.y + halfHeight);
    ctx.rotate(player.tilt);

    // Shadow on the road.
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    roundedRect(-halfWidth + 3, -halfHeight + 5, player.width, player.height, 8);

    // Wheels, slightly wider than the body.
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(-halfWidth - 2, -halfHeight + 13, 6, 18);
    ctx.fillRect(halfWidth - 4, -halfHeight + 13, 6, 18);
    ctx.fillRect(-halfWidth - 2, halfHeight - 30, 6, 18);
    ctx.fillRect(halfWidth - 4, halfHeight - 30, 6, 18);

    // Door mirrors.
    ctx.fillStyle = "#1e40af";
    ctx.fillRect(-halfWidth - 3, -13, 5, 6);
    ctx.fillRect(halfWidth - 2, -13, 5, 6);

    // Body: blue, lighter along the middle so it looks rounded.
    const paint = ctx.createLinearGradient(-halfWidth, 0, halfWidth, 0);
    paint.addColorStop(0, "#1e3fae");
    paint.addColorStop(0.5, "#3b74ff");
    paint.addColorStop(1, "#1e3fae");

    ctx.fillStyle = paint;
    roundedRect(-halfWidth, -halfHeight, player.width, player.height, [11, 11, 6, 6]);

    // Front: grille opening and wide headlights.
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(-11, -halfHeight + 2, 22, 4);

    ctx.fillStyle = "#fef9c3";
    drawPolygon([[-22, -halfHeight + 5], [-13, -halfHeight + 3], [-13, -halfHeight + 9], [-22, -halfHeight + 11]]);
    drawPolygon([[22, -halfHeight + 5], [13, -halfHeight + 3], [13, -halfHeight + 9], [22, -halfHeight + 11]]);

    // Long bonnet: a raised centre section between two creases.
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    drawPolygon([[-8, -halfHeight + 9], [8, -halfHeight + 9], [11, -17], [-11, -17]]);

    ctx.strokeStyle = "rgba(10, 20, 60, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-8, -halfHeight + 9);
    ctx.lineTo(-11, -17);
    ctx.moveTo(8, -halfHeight + 9);
    ctx.lineTo(11, -17);
    ctx.stroke();

    // Glass: windscreen, side windows, rear window.
    ctx.fillStyle = "#0f172a";
    drawPolygon([[-20, -15], [20, -15], [16, -2], [-16, -2]]);
    drawPolygon([[-21, -12], [-17, -1], [-17, 21], [-21, 26]]);
    drawPolygon([[21, -12], [17, -1], [17, 21], [21, 26]]);
    drawPolygon([[-16, 20], [16, 20], [19, 30], [-19, 30]]);

    // Reflection on the windscreen.
    ctx.fillStyle = "rgba(148, 197, 255, 0.35)";
    drawPolygon([[-17, -13], [-6, -13], [-9, -4], [-14, -4]]);

    // Roof.
    ctx.fillStyle = "#4a80ff";
    roundedRect(-16, -2, 32, 22, 4);

    // Four round tail lights, the detail that says "Skyline".
    ctx.fillStyle = "#450a0a";
    ctx.fillRect(-22, halfHeight - 6, 44, 5);

    ctx.fillStyle = "#ff3b3b";
    drawCircle(-18, halfHeight - 3.5, 3);
    drawCircle(-10.5, halfHeight - 3.5, 2.4);
    drawCircle(10.5, halfHeight - 3.5, 2.4);
    drawCircle(18, halfHeight - 3.5, 3);

    // Rear wing: two supports and a wide blade.
    ctx.fillStyle = "#0f1f5c";
    ctx.fillRect(-15, halfHeight - 15, 3, 7);
    ctx.fillRect(12, halfHeight - 15, 3, 7);

    ctx.fillStyle = "#16297a";
    roundedRect(-halfWidth + 1, halfHeight - 14, player.width - 2, 6, 2);

    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.fillRect(-halfWidth + 3, halfHeight - 13, player.width - 6, 1);

    ctx.restore();
}

function drawTrafficVehicle(vehicle) {
    const x = vehicle.x;
    const y = vehicle.y;
    const width = vehicle.width;
    const height = vehicle.height;

    // Shadow and wheels are the same for every vehicle.
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    roundedRect(x + 3, y + 5, width, height, 8);

    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(x - 2, y + 12, 6, 18);
    ctx.fillRect(x + width - 4, y + 12, 6, 18);
    ctx.fillRect(x - 2, y + height - 30, 6, 18);
    ctx.fillRect(x + width - 4, y + height - 30, 6, 18);

    if (vehicle.kind === "truck") {
        // Cab at the front (top), cargo box behind it.
        ctx.fillStyle = vehicle.color;
        roundedRect(x + 3, y, width - 6, 34, [8, 8, 2, 2]);

        ctx.fillStyle = "#111827";
        ctx.fillRect(x + 8, y + 9, width - 16, 10);

        ctx.fillStyle = "#e2e8f0";
        roundedRect(x, y + 36, width, height - 36, 3);

        ctx.fillStyle = "#94a3b8";
        ctx.fillRect(x + 4, y + 36 + (height - 36) / 2, width - 8, 2);
    } else if (vehicle.kind === "van") {
        ctx.fillStyle = vehicle.color;
        roundedRect(x, y, width, height, [10, 10, 5, 5]);

        ctx.fillStyle = "#111827";
        ctx.fillRect(x + 6, y + 12, width - 12, 13);

        ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
        ctx.fillRect(x + 6, y + 32, width - 12, height - 42);
    } else {
        ctx.fillStyle = vehicle.color;
        roundedRect(x, y, width, height, 10);

        // Windscreen, roof shade and rear window.
        ctx.fillStyle = "#111827";
        ctx.fillRect(x + 7, y + 22, width - 14, 13);
        ctx.fillRect(x + 8, y + height - 28, width - 16, 9);

        ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
        ctx.fillRect(x + 7, y + 37, width - 14, height - 67);
    }

    // Tail lights: the player sees traffic from behind.
    ctx.fillStyle = "#fca5a5";
    ctx.fillRect(x + 5, y + height - 4, 9, 3);
    ctx.fillRect(x + width - 14, y + height - 4, 9, 3);
}

function render() {
    drawRoad();

    for (const vehicle of traffic) {
        drawTrafficVehicle(vehicle);
    }

    drawPlayer();

    // Short white flash at the moment of the crash.
    if (game.crashFlash > 0) {
        ctx.fillStyle = "rgba(255, 255, 255, " + game.crashFlash * 0.6 + ")";
        ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    }
}

/* ==========================================================
   7. Game loop
   ========================================================== */

let lastFrameTime = null;

// One loop for the whole life of the page. It always draws; "update"
// decides what moves depending on the current state.
function gameLoop(now) {
    if (lastFrameTime === null) {
        lastFrameTime = now;
    }

    // Seconds since the previous frame. Capped so a long freeze
    // cannot teleport cars through each other.
    const dt = Math.min((now - lastFrameTime) / 1000, MAX_FRAME_TIME);
    lastFrameTime = now;

    update(dt);
    render();

    requestAnimationFrame(gameLoop);
}

window.addEventListener("resize", setupCanvas);

setupCanvas();
player.x = VIEW_WIDTH / 2 - player.width / 2;
updateHud();
requestAnimationFrame(gameLoop);
