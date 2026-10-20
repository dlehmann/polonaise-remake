/*
 * game.ts - Polonaise game logic: a conga line on a disco dance floor, steered
 * like Snake. Guests touched by the leader join at the end of the line; a crash
 * into a wall, the furniture or the own line costs a life and half the line.
 *
 * A port of games/polonaise/src/game.c of the arcade cabinet. The module does not
 * depend on the browser: the logic runs in fixed ticks of 1/TICK_HZ seconds,
 * tick() takes the input of one tick and reports what happened in it as events
 * (which the renderer and the audio turn into effects and sounds).
 *
 * The playing field is a grid of COLS x ROWS cells, addressed by a single cell
 * index (y * COLS + x).
 */

/** Logic ticks per second. */
export const TICK_HZ = 60;
/** On an info screen, A (Enter, tap) skips ahead only after this many ticks. */
export const SKIP_TICKS = TICK_HZ;
/** Width of the playing field in cells. */
export const COLS = 19;
/** Height of the playing field in cells. */
export const ROWS = 12;
/** Number of cells of the playing field. */
export const CELLS = COLS * ROWS;
/** Guest slots: guests on the floor at the same time at most. */
export const MAX_GUESTS = 32;
/** Direction changes buffered ahead of the steps of the line. */
export const TURN_QUEUE = 2;
/** Number of looks (outfits); guests get 1 .. LOOKS - 1, 0 is the leader. */
export const LOOKS = 64;

/** Lives at the start of a game. */
export const LIVES_START = 3;
/** Lives at most (extra lives beyond are not counted). */
export const LIVES_MAX = 5;
/** Catching the next guest within this many ticks raises the combo multiplier. */
export const COMBO_TICKS = 4 * TICK_HZ;
/** Highest combo multiplier. */
export const COMBO_MAX = 5;
/** A golden star guest stays on the floor this many ticks. */
export const STAR_TICKS = 8 * TICK_HZ;
/** A new star appears after this many ticks of moving (from song 2). */
export const STAR_EVERY = 15 * TICK_HZ;
/** Shy guests run from the leader when it gets this close (in cells, Manhattan distance). */
export const FLEE_DISTANCE = 3;

/** Points for a dancer, times the combo multiplier. */
export const POINTS_DANCER = 100;
/** Points for a shy guest, times the combo multiplier. */
export const POINTS_SHY = 200;
/** Points for a star, times the combo multiplier. */
export const POINTS_STAR = 500;
/** Song bonus per guest in the line. */
export const POINTS_FOLLOWER = 100;
/** Song bonus, times the song number. */
export const POINTS_SONG = 1000;
/** Song bonus for a song without a crash. */
export const POINTS_PERFECT = 2000;

/** Directions; the order matters: (d + 2) % 4 is the reverse direction. */
export const DIR = { RIGHT: 0, DOWN: 1, LEFT: 2, UP: 3, NONE: 4 } as const;
export type Dir = (typeof DIR)[keyof typeof DIR];

/** What stands on a cell. */
export const TILE = { FLOOR: 0, DJ: 1, TABLE: 2, SPEAKER: 3, BAR: 4 } as const;
export type Tile = (typeof TILE)[keyof typeof TILE];

/** Kinds of guests. */
export const GUEST = { DANCER: 0, SHY: 1, STAR: 2 } as const;
export type GuestType = (typeof GUEST)[keyof typeof GUEST];

/** Phases of a song. */
export const PHASE = { INTRO: 0, PLAY: 1, CRASH: 2, CLEARED: 3, GAME_OVER: 4 } as const;
export type Phase = (typeof PHASE)[keyof typeof PHASE];

/** Event types. Most of them are also the names of the sounds played for them. */
export const EV = {
    TURN: 'turn', GO: 'go', DENY: 'deny', GRACE: 'grace', CATCH: 'catch', FLEE: 'flee', STAR: 'star',
    STAR_GONE: 'star-gone', CRASH: 'crash', EXTRA_LIFE: 'extra-life', SONG_START: 'song-start',
    PLAY: 'play', CLEARED: 'cleared', GAME_OVER: 'game-over',
} as const;
export type EventType = (typeof EV)[keyof typeof EV];

/**
 * Something that happened in a tick. The meaning of count, index and points depends on the
 * type, e.g. for CATCH: count is the combo multiplier, index the guest type, points the points.
 */
export interface GameEvent {
    type: EventType;
    /** The cell where it happened. */
    cell: number;
    count: number;
    index: number;
    points: number;
}

/** A guest on the dance floor (or a free slot, when not active). */
export interface Guest {
    active: boolean;
    type: GuestType;
    /** The current cell. */
    cell: number;
    /** The previous cell, for the animation of a step. */
    from: number;
    /** Ticks since the last step. */
    moved: number;
    /** The outfit, 1 .. LOOKS - 1. */
    look: number;
    /** Ticks since it appeared. */
    age: number;
}

/** The parameters of a song. */
export interface Song {
    /** Guests in the line needed to clear the song. */
    target: number;
    /** Ticks per step of the line: the beat. */
    stepTicks: number;
    /** Guests waiting on the floor at least (without stars). */
    guests: number;
    /** Chance in percent that a new guest is shy. */
    shyPercent: number;
    /** Index into LAYOUTS. */
    layout: number;
}

/** Ticks of the intro of the first song (it shows the controls). */
const FIRST_INTRO_TICKS = 20 * TICK_HZ;
const INTRO_TICKS = 4 * TICK_HZ;
const CRASH_TICKS = 3 * TICK_HZ / 2;
const CLEARED_TICKS = 7 * TICK_HZ;
const GAME_OVER_TICKS = 6 * TICK_HZ;
/** New guests appear at least this far from the leader (if there is room). */
const SPAWN_DISTANCE = 4;
const START_X = 9;
const START_Y = 9;

/*
 * Floor layouts, one per song (repeating): '.' floor, 'D' DJ desk, 'T' high table,
 * 'S' speaker, 'B' bar counter. The start cell and its row stay free.
 */
const E = '...................';
const LAYOUTS: readonly (readonly string[])[] = [
    [E, E, E, E, E, E, E, E, E, E, E, E],
    ['.......DDDDD.......', E, E, E, E, E, E, E, E, E, E, E],
    ['.......DDDDD.......', E, E, '....T.........T....', E, E, E, E, '....T.........T....', E, E, E],
    ['SS.....DDDDD.....SS', 'SS...............SS', E, E, E, E, E, E, E, E,
     'SS...............SS', 'SS...............SS'],
    ['.......DDDDD.......', E, E, E, '...T...........T...', E, E, '...T...........T...', E, E, E,
     '.....BBBBBBBBB.....'],
    ['SS.....DDDDD.....SS', 'SS...............SS', E, E, E, '........TTT........', '........TTT........',
     E, E, E, 'SS...............SS', 'SS...............SS'],
    ['.......DDDDD.......', E, E, '.....B.......B.....', '.....B.......B.....', '.....B.......B.....',
     '.....B.......B.....', '.....B.......B.....', '.....B.......B.....', E, E, E],
    ['SS.....DDDDD.....SS', 'SS...............SS', '..T......T......T..', E, E, '.....T.......T.....',
     E, E, E, E, '..T......T......T..', E],
];

/** Ticks per step for the songs 1, 2, ...; later songs use STEP_MIN. */
const STEP_TICKS = [10, 9, 9, 8, 8, 7, 7, 6, 6, 6, 6];
const STEP_MIN = 5;
/** Shy guests in percent for the songs 1, 2, ...; later songs use the last value. */
const SHY_PERCENT = [0, 25, 30, 35, 40, 45, 50];
const TARGET_START = 8, TARGET_STEP = 2, TARGET_MAX = 24, GUESTS_MAX = 6;
/** Scores that give an extra life. */
const EXTRA_LIVES = [15000, 40000, 80000, 150000];
/** Cell offsets per direction. */
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/** The parameters of song n (1, 2, ...). */
export function songGet(n: number): Song {
    n = Math.max(1, n);
    return {
        target: Math.min(TARGET_START + TARGET_STEP * (n - 1), TARGET_MAX),
        stepTicks: n <= STEP_TICKS.length ? STEP_TICKS[n - 1] : STEP_MIN,
        guests: Math.min(3 + Math.floor((n - 1) / 2), GUESTS_MAX),
        shyPercent: SHY_PERCENT[Math.min(n, SHY_PERCENT.length) - 1],
        layout: (n - 1) % LAYOUTS.length,
    };
}

/** The score for the n-th extra life (0, 1, ...), 0 if there is none. */
export function extraLifeScore(n: number): number {
    return n >= 0 && n < EXTRA_LIVES.length ? EXTRA_LIVES[n] : 0;
}

/** The length of the intro of a song in ticks. */
export function introTicks(song: number): number {
    return song === 1 ? FIRST_INTRO_TICKS : INTRO_TICKS;
}

/** The cell where the leader starts each song. */
export function startCell(): number {
    return START_Y * COLS + START_X;
}

/** The neighbour of a cell in direction d, or -1 outside the field. */
export function nextCell(cell: number, d: Dir): number {
    if (d === DIR.NONE)
        return cell;
    const x = cell % COLS + DX[d], y = Math.floor(cell / COLS) + DY[d];
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS)
        return -1;
    return y * COLS + x;
}

/** The Manhattan distance of two cells. */
function distance(a: number, b: number): number {
    return Math.abs(a % COLS - b % COLS) + Math.abs(Math.floor(a / COLS) - Math.floor(b / COLS));
}

/**
 * One run of the game, from song 1 until the last life is lost. All randomness comes from
 * a seeded generator, so a run is reproducible from its seed and inputs.
 */
export class Game {
    /** State of the random number generator. */
    private rng: number;
    phase: Phase = PHASE.INTRO;
    /** Ticks since the phase began. */
    timer = 0;
    /** Set after the game over screen: the run is finished. */
    done = false;
    song = 1;
    score = 0;
    lives = LIVES_START;
    /** Extra lives earned so far (also those beyond LIVES_MAX). */
    private extraLives = 0;
    /** Crashes in the current song (none: the perfect bonus). */
    private songCrashes = 0;
    /** The furniture per cell. */
    readonly tile = new Uint8Array(CELLS);
    /** Members of the line, the leader included. */
    length = 1;
    /** The cell of each member of the line; body[0] is the leader. */
    readonly body = new Int32Array(CELLS);
    /** The cell of each member before the last step, for the animation. */
    readonly from = new Int32Array(CELLS);
    /** The outfit of each member. */
    readonly look = new Uint8Array(CELLS);
    /** The line is walking (false: it waits for a direction). */
    moving = false;
    dir: Dir = DIR.RIGHT;
    /** Buffered direction changes. */
    private queue: Dir[] = [];
    /** Ticks since the last step. */
    stepTimer = 0;
    /** The line stands in front of an obstacle: the next blocked step crashes. */
    private grace = false;
    /** Steps taken in this run (for the walking animation). */
    steps = 0;
    readonly guests: Guest[] = [];
    /** Ticks until the next star. */
    private starTimer = STAR_EVERY;
    /** The current combo multiplier (0: none). */
    combo = 0;
    /** Ticks left for the next catch to raise the combo. */
    comboTimer = 0;
    /** Guests that let go of the line in the last crash. */
    dropped = 0;
    /** The parts of the bonus of the last cleared song, for the summary screen. */
    bonusFollowers = 0;
    bonusLine = 0;
    bonusSong = 0;
    bonusPerfect = 0;
    /** What happened in the last tick. */
    events: GameEvent[] = [];

    /** Starts a game at song 1; the seed selects the random sequence. */
    constructor(seed = Date.now() >>> 0) {
        this.rng = seed >>> 0 || 0x3141;
        for (let i = 0; i < MAX_GUESTS; i++)
            this.guests.push({ active: false, type: GUEST.DANCER, cell: 0, from: 0, moved: 0, look: 1, age: 0 });
        this.startSong();
    }

    /** Jumps to another song (used for the demo on the title screen). */
    startAt(song: number): void {
        this.song = Math.max(1, song);
        this.events = [];
        this.startSong();
    }

    /** The guests in the line (without the leader). */
    followers(): number {
        return this.length - 1;
    }

    /** A pseudo random number of 24 bits (a linear congruential generator). */
    private random(): number {
        this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
        return this.rng >>> 8;
    }

    private event(type: EventType, cell: number, count = 0, index = 0, points = 0): void {
        this.events.push({ type, cell, count, index, points });
    }

    private setPhase(p: Phase): void {
        this.phase = p;
        this.timer = 0;
    }

    /** The index of the line member on a cell, or -1. */
    private memberAt(cell: number): number {
        for (let i = 0; i < this.length; i++)
            if (this.body[i] === cell)
                return i;
        return -1;
    }

    /** Whether furniture or the line stands on a cell. */
    cellBlocked(cell: number): boolean {
        return this.tile[cell] !== TILE.FLOOR || this.memberAt(cell) >= 0;
    }

    /** The slot of the guest on a cell, or -1. */
    private guestAt(cell: number): number {
        for (let i = 0; i < MAX_GUESTS; i++)
            if (this.guests[i].active && this.guests[i].cell === cell)
                return i;
        return -1;
    }

    /** Whether a cell is inside the field and empty. */
    private cellFree(cell: number): boolean {
        return cell >= 0 && !this.cellBlocked(cell) && this.guestAt(cell) < 0;
    }

    /** Adds points and hands out the extra lives they earn. */
    private addScore(points: number): void {
        this.score += points;
        while (extraLifeScore(this.extraLives) && this.score >= extraLifeScore(this.extraLives)) {
            this.extraLives++;
            if (this.lives < LIVES_MAX) {
                this.lives++;
                this.event(EV.EXTRA_LIFE, this.body[0], this.lives);
            }
        }
    }

    /** A random free cell away from the leader and not right in front of it; -1 if none. */
    private spawnCell(): number {
        const ahead = this.moving ? nextCell(this.body[0], this.dir) : -1;
        let cells: number[] = [];

        for (let c = 0; c < CELLS; c++)
            if (this.cellFree(c) && distance(c, this.body[0]) >= SPAWN_DISTANCE && c !== ahead)
                cells.push(c);
        if (!cells.length)
            for (let c = 0; c < CELLS; c++)
                if (this.cellFree(c) && c !== ahead)
                    cells.push(c);
        if (!cells.length)
            return -1;
        return cells[this.random() % cells.length];
    }

    /** Puts a guest on a cell (with a random look unless one is given); the slot or -1. */
    private addGuest(type: GuestType, cell: number, look = 0): number {
        const slot = this.guests.findIndex(g => !g.active);
        if (slot < 0 || cell < 0)
            return -1;
        Object.assign(this.guests[slot], {
            active: true, type, cell, from: cell, moved: TICK_HZ, age: 0,
            look: look || 1 + this.random() % (LOOKS - 1),
        });
        return slot;
    }

    /** Keeps at least the song's number of guests (without stars) on the floor. */
    private fillGuests(): void {
        const s = songGet(this.song);
        let n = this.guests.filter(g => g.active && g.type !== GUEST.STAR).length;

        for (; n < s.guests; n++) {
            const t = this.random() % 100 < s.shyPercent ? GUEST.SHY : GUEST.DANCER;
            if (this.addGuest(t, this.spawnCell()) < 0)
                break;
        }
    }

    /** Sets up the floor of the current song: furniture, the lone leader, fresh guests. */
    private startSong(): void {
        const s = songGet(this.song);
        const kinds: Record<string, Tile> = { D: TILE.DJ, T: TILE.TABLE, S: TILE.SPEAKER, B: TILE.BAR };

        for (let y = 0; y < ROWS; y++)
            for (let x = 0; x < COLS; x++)
                this.tile[y * COLS + x] = kinds[LAYOUTS[s.layout][y][x]] ?? TILE.FLOOR;
        this.length = 1;
        this.body[0] = this.from[0] = startCell();
        this.look[0] = 0;
        this.moving = false;
        this.dir = DIR.RIGHT;
        this.queue = [];
        this.stepTimer = 0;
        for (const g of this.guests)
            g.active = false;
        this.starTimer = STAR_EVERY;
        this.combo = this.comboTimer = 0;
        this.songCrashes = 0;
        this.fillGuests();
        this.setPhase(PHASE.INTRO);
        this.event(EV.SONG_START, this.body[0], this.song);
    }

    /** The line is long enough: the bonus is added and the summary screen begins. */
    private finishSong(): void {
        this.bonusFollowers = this.followers();
        this.bonusLine = POINTS_FOLLOWER * this.bonusFollowers;
        this.bonusSong = POINTS_SONG * this.song;
        this.bonusPerfect = this.songCrashes ? 0 : POINTS_PERFECT;
        const bonus = this.bonusLine + this.bonusSong + this.bonusPerfect;
        this.addScore(bonus);
        this.moving = false;
        this.setPhase(PHASE.CLEARED);
        this.event(EV.CLEARED, this.body[0], this.bonusFollowers, 0, bonus);
    }

    /**
     * The leader ran into something: a life and the back half of the line are lost. The
     * guests who let go stay where they are and dance again.
     */
    private crash(): void {
        const drop = Math.floor((this.followers() + 1) / 2);

        for (let k = 0; k < drop; k++) {
            const i = this.length - 1 - k;
            this.addGuest(GUEST.DANCER, this.body[i], this.look[i]);
        }
        this.length -= drop;
        for (let i = 0; i < this.length; i++)
            this.from[i] = this.body[i];
        this.dropped = drop;
        this.lives--;
        this.songCrashes++;
        this.moving = false;
        this.queue = [];
        this.grace = false;
        this.combo = this.comboTimer = 0;
        this.event(EV.CRASH, this.body[0], drop, this.lives);
        if (this.lives <= 0) {
            this.setPhase(PHASE.GAME_OVER);
            this.event(EV.GAME_OVER, this.body[0]);
        } else {
            this.setPhase(PHASE.CRASH);
        }
    }

    /** The leader touched a guest: points (times the combo) and a longer combo. */
    private catchGuest(slot: number): void {
        const g = this.guests[slot];
        let points = g.type === GUEST.STAR ? POINTS_STAR : g.type === GUEST.SHY ? POINTS_SHY : POINTS_DANCER;

        this.combo = this.comboTimer > 0 ? Math.min(this.combo + 1, COMBO_MAX) : 1;
        this.comboTimer = COMBO_TICKS;
        points *= this.combo;
        g.active = false;
        this.event(EV.CATCH, g.cell, this.combo, g.type, points);
        this.addScore(points);
    }

    /** Whether the leader's next step onto a cell is blocked. The end of the line moves on, so
     * it does not count (unless the line is so short that the leader would turn around). */
    private stepBlocked(cell: number): boolean {
        if (cell < 0 || this.tile[cell] !== TILE.FLOOR)
            return true;
        const m = this.memberAt(cell);
        return m >= 0 && (m !== this.length - 1 || this.length === 1 || m === 1);
    }

    /** One step of the line in its direction (after a buffered turn). */
    private step(): void {
        const d = this.queue.shift();
        if (d !== undefined) {
            if (d !== this.dir)
                this.event(EV.TURN, this.body[0], 0, d);
            this.dir = d;
        }
        const target = nextCell(this.body[0], this.dir);
        if (this.stepBlocked(target)) {
            // one step of grace: the line stands still and a turn can still save it
            if (this.grace) {
                this.crash();
                return;
            }
            this.grace = true;
            for (let i = 0; i < this.length; i++)
                this.from[i] = this.body[i];
            this.event(EV.GRACE, this.body[0], 0, this.dir);
            return;
        }
        this.grace = false;
        const slot = this.guestAt(target);
        for (let i = 0; i < this.length; i++)
            this.from[i] = this.body[i];
        if (slot >= 0) {
            // the new member appears at the end of the line, where the last one stood
            this.body[this.length] = this.from[this.length] = this.body[this.length - 1];
            this.look[this.length] = this.guests[slot].look;
        }
        for (let i = this.length - 1; i > 0; i--)
            this.body[i] = this.body[i - 1];
        this.body[0] = target;
        this.steps++;
        if (slot < 0)
            return;
        this.length++;
        this.catchGuest(slot);
        if (this.followers() >= songGet(this.song).target)
            this.finishSong();
        else
            this.fillGuests();
    }

    /** Shy guests close to the leader step to the free neighbour farthest from it (at half
     * the leader's speed); among equally far ones, to the one with the most free neighbours. */
    private flee(): void {
        const s = songGet(this.song), head = this.body[0];

        this.guests.forEach((g, i) => {
            if (!g.active || g.type !== GUEST.SHY || g.moved < 2 * s.stepTicks)
                return;
            if (distance(g.cell, head) > FLEE_DISTANCE)
                return;
            let best = -1, bestD = distance(g.cell, head), bestFree = -1;
            for (let d = 0; d < 4; d++) {
                const c = nextCell(g.cell, d as Dir);
                if (!this.cellFree(c))
                    continue;
                const dist = distance(c, head);
                let nfree = 0;
                for (let e = 0; e < 4; e++)
                    nfree += this.cellFree(nextCell(c, e as Dir)) ? 1 : 0;
                if (dist > bestD || (dist === bestD && best >= 0 && nfree > bestFree)) {
                    best = c;
                    bestD = dist;
                    bestFree = nfree;
                }
            }
            if (best < 0)
                return;
            g.from = g.cell;
            g.cell = best;
            g.moved = 0;
            this.event(EV.FLEE, best, 0, i);
        });
    }

    /** Old stars leave; from song 2 a new one appears now and then while the line moves. */
    private stars(): void {
        this.guests.forEach((g, i) => {
            if (g.active && g.type === GUEST.STAR && g.age >= STAR_TICKS) {
                g.active = false;
                this.event(EV.STAR_GONE, g.cell, 0, i);
            }
        });
        if (this.song < 2 || !this.moving || --this.starTimer > 0)
            return;
        this.starTimer = STAR_EVERY;
        if (this.guests.some(g => g.active && g.type === GUEST.STAR))
            return;
        const slot = this.addGuest(GUEST.STAR, this.spawnCell());
        if (slot >= 0)
            this.event(EV.STAR, this.guests[slot].cell, 0, slot);
    }

    /** The line waits: a free direction starts it, a blocked one is refused. */
    private go(d: Dir): void {
        const target = nextCell(this.body[0], d);

        if (this.stepBlocked(target) || (this.length > 1 && target === this.body[1])) {
            this.event(EV.DENY, this.body[0], 0, d);
            return;
        }
        this.dir = d;
        this.queue = [];
        this.grace = false;
        this.moving = true;
        this.stepTimer = 0;
        this.event(EV.GO, this.body[0], 0, d);
        this.step();
    }

    /** While moving, direction changes are queued for the next steps; a reversal is ignored. */
    private turn(d: Dir): void {
        const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;

        if (d === last || (this.length > 1 && d === (last + 2) % 4) || this.queue.length >= TURN_QUEUE)
            return;
        this.queue.push(d);
    }

    /** A tick of the PLAY phase. */
    private play(d: Dir): void {
        const s = songGet(this.song);

        for (const g of this.guests)
            if (g.active) {
                g.moved++;
                g.age++;
            }
        if (!this.moving) {
            if (d !== DIR.NONE)
                this.go(d);
            if (this.phase !== PHASE.PLAY)
                return;
            this.stars();
            return;
        }
        if (d !== DIR.NONE)
            this.turn(d);
        if (this.comboTimer > 0)
            this.comboTimer--;
        if (++this.stepTimer >= s.stepTicks) {
            this.stepTimer = 0;
            this.step();
            if (this.phase !== PHASE.PLAY)
                return;
        }
        this.flee();
        this.stars();
    }

    /**
     * Advances the game by one tick.
     * @param d the direction pressed in this tick, or DIR.NONE
     * @param a whether A (Enter, Space, a tap) was pressed in this tick
     */
    tick(d: Dir, a: boolean): void {
        this.events = [];
        this.timer++;

        switch (this.phase) {
        case PHASE.INTRO:
            if (this.timer >= introTicks(this.song) || (this.timer >= SKIP_TICKS && (a || d !== DIR.NONE))) {
                this.setPhase(PHASE.PLAY);
                this.event(EV.PLAY, this.body[0]);
                if (d !== DIR.NONE)
                    this.go(d);
            }
            break;
        case PHASE.PLAY:
            this.play(d);
            break;
        case PHASE.CRASH:
            for (const g of this.guests)
                if (g.active)
                    g.moved++;
            if (this.timer >= CRASH_TICKS)
                this.setPhase(PHASE.PLAY);
            break;
        case PHASE.CLEARED:
            if (this.timer >= CLEARED_TICKS || (this.timer >= SKIP_TICKS && a)) {
                this.song++;
                this.startSong();
            }
            break;
        case PHASE.GAME_OVER:
            if (this.timer >= GAME_OVER_TICKS)
                this.done = true;
            break;
        }
    }
}
