/*
 * draw.ts - Polonaise graphics on a 640x480 canvas, a port of
 * games/polonaise/src/draw.c of the arcade cabinet.
 *
 * The world is pixel art at 320x240, every pixel drawn as a 2x2 block ("art
 * pixels"): a dark purple checkered dance floor with grain, tiles lighting up to
 * the beat, a frame of running LED lights, furniture and people as 16x16 sprites with a dark outline, built once per look
 * from rectangles. The status bar, the info screens and the texts are drawn in
 * screen pixels with the pixel font Press Start 2P.
 *
 * The renderer only reads the game state. Its own state (confetti, floating
 * texts, screen shake) advances in tick(), once per logic tick, and reacts to
 * the game's events in event().
 */
import {
    CELLS, COLS, COMBO_TICKS, DIR, EV, Game, type GameEvent, GUEST, LIVES_START, LOOKS, MAX_GUESTS, nextCell,
    PHASE, ROWS, SKIP_TICKS, songGet, STAR_TICKS, TICK_HZ, TILE, type Dir,
} from './game';
import { t, tn } from './i18n';
import type { ScoreEntry } from './scores';

/** The size of the canvas in screen pixels. */
export const SCREEN_W = 640;
export const SCREEN_H = 480;

/** Screen pixels per art pixel. */
const PIX = 2;
/** The size of a cell in art pixels. */
const CELL = 16;
/** The top-left corner of the playing field in art pixels. */
const FIELD_X = 8, FIELD_Y = 40;
const FIELD_W = COLS * CELL, FIELD_H = ROWS * CELL;
/** The height of the status bar in art pixels. */
const HUD_H = 32;
/** The horizontal center of the screen. */
const CX = SCREEN_W / 2;

/** A sprite is a bit larger than a cell (outline, hair above the head) and has its own origin. */
const SPR_W = 18, SPR_H = 22, SPR_OX = 1, SPR_OY = 5;
/** The look of the DJ, after the guests'. */
const LOOK_DJ = LOOKS;

const BEAT_TICKS = 30;          // 120 bpm, the tempo of the music
const FLEE_TICKS = 40;          // "!" over a shy guest
const GUEST_STEP = 8;           // ticks of a guest's step
const SHAKE_TICKS = 20;
const FLASH_TICKS = 24;

/**
 * Where the name input of the high score entry sits, in screen pixels. The form is an
 * HTML element over the canvas (for the on-screen keyboards of phones); view.ts places it.
 */
export const ENTRY_FORM = { x: 176, y: 248, w: 288, h: 36 } as const;

/** A color as red, green, blue, alpha (0..255). */
export type Color = readonly [number, number, number, number];

/** A color from 0xRRGGBB. */
const rgb = (v: number): Color => [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
/** The color between a and b, t from 0 (a) to 1 (b). */
const mix = (a: Color, b: Color, t: number): Color => {
    const f = Math.min(1, Math.max(0, t));
    return [0, 1, 2, 3].map(i => Math.round(a[i] + (b[i] - a[i]) * f)) as unknown as Color;
};
/** A color with another alpha. */
const alpha = (c: Color, a: number): Color => [c[0], c[1], c[2], Math.max(0, Math.min(255, a))];
/** A color for the canvas fill style. */
const css = (c: Color): string => `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

/** The palette. */
export const C = {
    HUD_BG: [20, 16, 34, 255], HUD_LINE: [42, 32, 72, 255], FRAME_BG: [26, 20, 36, 255],
    FLOOR_A: [43, 31, 76, 255], FLOOR_B: [51, 38, 90, 255], OUTLINE: [11, 11, 18, 255],
    GOLD_LINE: [255, 214, 74, 255], LABEL: [138, 144, 168, 255], TEXT: [214, 208, 240, 255],
    DIM: [60, 50, 92, 255], PINK: [255, 61, 154, 255], CYAN: [61, 240, 255, 255],
    YELLOW: [255, 224, 61, 255], GREEN: [125, 255, 90, 255], RED: [255, 77, 109, 255],
    GOLD: [255, 200, 61, 255], WHITE: [255, 255, 255, 255], BLACK: [0, 0, 0, 255],
} as const satisfies Record<string, Color>;
/** The colors of the disco lights. */
const LIT: readonly Color[] = [[255, 61, 154, 255], [61, 240, 255, 255], [255, 224, 61, 255],
                               [125, 255, 90, 255], [180, 107, 255, 255]];
/** The color of a combo multiplier (1..5). */
const COMBO_COLOR: readonly Color[] = [C.WHITE, C.WHITE, C.CYAN, C.PINK, C.YELLOW, C.GREEN];

/* ---- People ---- */

const SKIN = [0xf1c9a5, 0xe0ac83, 0xc68a5e, 0xa0673f, 0x7a4a30, 0x5a3a26];
const HAIR = [0x1a1210, 0x3b2314, 0x6b3a1a, 0xa0461e, 0xe8c15a, 0xc8c8d0];
const PUNK = [0xff4fa3, 0x3df0ff, 0x7dff5a];
const SHIRT = [0xff3d9a, 0x3df0ff, 0xffe03d, 0x7dff5a, 0xb46bff, 0xff8a3d, 0xf4f4f4, 0xff5a5a, 0x4f7dff,
               0x2ad1b0];
const PANTS = [0x2b2b55, 0x3a3a3a, 0x1f3a6a, 0x5a3a1a, 0xe8e8f0];
/** Hair styles. */
const H = { SHORT: 0, LONG: 1, BUN: 2, MOHAWK: 3, CURLY: 4, CAP: 5, PONYTAIL: 6, BALD: 7, STYLES: 8 } as const;

/** The outfit of a person. */
interface Look {
    skin: Color;
    hair: Color;
    shirt: Color;
    pants: Color;
    shoes: Color;
    style: number;
    glasses?: boolean;
    /** A dress instead of trousers. */
    dress?: boolean;
    /** The gold chain of the leader. */
    chain?: boolean;
    /** The headphones of the DJ. */
    headphones?: boolean;
}

/** Draws a rectangle of cell pixels into a sprite. */
type Put = (x: number, y: number, w: number, h: number, c: Color) => void;

/**
 * The looks: 0 the leader, 1 .. LOOKS - 1 the guests, LOOK_DJ the DJ. The guests' looks
 * are derived from a hash of their number, so they are the same in every run.
 */
function makeLooks(): Look[] {
    const looks: Look[] = [];
    for (let i = 1; i < LOOKS; i++) {
        let h = Math.imul(i, 2654435761) >>> 0;
        h = (h ^ (h >>> 13)) >>> 0;
        const l: Look = {
            skin: rgb(SKIN[h % SKIN.length]),
            style: (h >>> 4) % H.STYLES,
            hair: rgb(HAIR[(h >>> 8) % HAIR.length]),
            shirt: rgb(SHIRT[(h >>> 14) % SHIRT.length]),
            pants: rgb(PANTS[(h >>> 18) % PANTS.length]),
            shoes: (h >>> 21) % 3 ? rgb(0x15121c) : rgb(0xf4f4f4),
            glasses: (h >>> 25) % 7 === 0,
        };
        if (l.style === H.MOHAWK)
            l.hair = rgb(PUNK[(h >>> 11) % PUNK.length]);
        if (l.style === H.CAP)
            l.hair = rgb(SHIRT[(h >>> 11) % SHIRT.length]);
        l.dress = (l.style === H.LONG || l.style === H.BUN || l.style === H.PONYTAIL) && (h >>> 23) % 2 === 1;
        looks[i] = l;
    }
    // the leader: white disco suit, sunglasses, gold chain
    looks[0] = { skin: rgb(0xc68a5e), hair: rgb(0x1a1210), shirt: rgb(0xf4f4f4), pants: rgb(0xf4f4f4),
                 shoes: rgb(0xf4f4f4), style: H.SHORT, glasses: true, chain: true };
    // the DJ: black shirt, headphones
    looks[LOOK_DJ] = { skin: rgb(0xe0ac83), hair: rgb(0x3b2314), shirt: rgb(0x1d1a2e), pants: rgb(0x2b2b55),
                       shoes: rgb(0x15121c), style: H.SHORT, headphones: true };
    return looks;
}

/**
 * Paints a person in front view, in cell pixels: head 4..11 x 1..7, body 3..12 x 8..11,
 * legs 12..15 (hair may reach above 0).
 * @param legs which foot is forward (0 or 1)
 * @param armsUp arms raised (dancing, or a shy guest in panic)
 */
function paint(put: Put, l: Look, legs: number, armsUp: boolean): void {
    const eye = rgb(0x111111), mouth = rgb(0x8a3a3a);

    if (l.dress) {
        put(3, 12, 10, 2, l.shirt);
        put(5, 14, 2, 1, l.skin);
        put(9, 14, 2, 1, l.skin);
    } else {
        put(4, 12, 8, 2, l.pants);
        put(4, 14, 3, 1, l.pants);
        put(9, 14, 3, 1, l.pants);
    }
    put(legs ? 4 : 3, legs ? 15 : 14, 3, 1, l.shoes);
    put(legs ? 10 : 9, legs ? 14 : 15, 3, 1, l.shoes);
    put(legs ? 4 : 9, 14, 3, 1, l.dress ? l.skin : l.pants);

    put(3, 8, 10, 4, l.shirt);
    if (armsUp) {
        put(2, 3, 1, 4, l.skin);
        put(13, 3, 1, 4, l.skin);
        put(2, 7, 1, 2, l.shirt);
        put(13, 7, 1, 2, l.shirt);
    } else {
        put(2, 8, 1, 2, l.shirt);
        put(13, 8, 1, 2, l.shirt);
        put(2, 10, 1, 2, l.skin);
        put(13, 10, 1, 2, l.skin);
    }
    if (l.chain) {
        put(6, 8, 4, 1, C.GOLD);
        put(7, 9, 2, 1, C.GOLD);
    }

    put(4, 1, 8, 7, l.skin);
    put(3, 4, 1, 2, l.skin);
    put(12, 4, 1, 2, l.skin);
    switch (l.style) {
    case H.SHORT:
        put(4, 0, 8, 2, l.hair);
        put(4, 2, 1, 2, l.hair);
        put(11, 2, 1, 2, l.hair);
        break;
    case H.LONG:
        put(4, 0, 8, 2, l.hair);
        put(3, 2, 2, 7, l.hair);
        put(11, 2, 2, 7, l.hair);
        break;
    case H.BUN:
        put(6, -2, 4, 2, l.hair);
        put(4, 0, 8, 2, l.hair);
        put(4, 2, 1, 1, l.hair);
        put(11, 2, 1, 1, l.hair);
        break;
    case H.MOHAWK:
        put(7, -3, 2, 4, l.hair);
        break;
    case H.CURLY:
        put(3, -1, 10, 3, l.hair);
        put(2, 0, 1, 5, l.hair);
        put(13, 0, 1, 5, l.hair);
        put(3, 2, 1, 2, l.hair);
        put(12, 2, 1, 2, l.hair);
        break;
    case H.CAP:
        put(4, -1, 8, 3, l.hair);
        put(3, 2, 10, 1, mix(l.hair, C.BLACK, 0.3));
        break;
    case H.PONYTAIL:
        put(4, 0, 8, 2, l.hair);
        put(4, 2, 1, 1, l.hair);
        put(12, 1, 2, 2, l.hair);
        put(13, 3, 1, 4, l.hair);
        break;
    }
    if (l.headphones) {
        put(4, -1, 8, 1, C.PINK);
        put(3, 0, 1, 3, C.PINK);
        put(12, 0, 1, 3, C.PINK);
        put(2, 3, 2, 3, C.PINK);
        put(12, 3, 2, 3, C.PINK);
    }
    if (l.glasses) {
        put(5, 4, 6, 2, eye);
        put(6, 4, 1, 1, rgb(0x6a6a90));
        put(9, 4, 1, 1, rgb(0x6a6a90));
    } else {
        put(6, 4, 1, 2, eye);
        put(9, 4, 1, 2, eye);
    }
    put(7, 6, 2, 1, mouth);
}

/**
 * Renders a person into a small canvas of SPR_W x SPR_H art pixels, with a one pixel
 * outline (golden for stars) around all painted pixels.
 * @param frame bit 0: the legs, bit 1: arms up
 */
function buildSprite(look: Look, frame: number, golden: boolean): HTMLCanvasElement {
    const pix: (Color | null)[] = new Array<Color | null>(SPR_W * SPR_H).fill(null);
    const put: Put = (x, y, w, h, c) => {
        for (let yy = y; yy < y + h; yy++)
            for (let xx = x; xx < x + w; xx++) {
                const px = xx + SPR_OX, py = yy + SPR_OY;
                if (px >= 0 && px < SPR_W && py >= 0 && py < SPR_H)
                    pix[py * SPR_W + px] = c;
            }
    };
    paint(put, look, frame & 1, (frame >> 1) === 1);

    const canvas = document.createElement('canvas');
    canvas.width = SPR_W;
    canvas.height = SPR_H;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(SPR_W, SPR_H);
    const line = golden ? C.GOLD_LINE : C.OUTLINE;
    for (let y = 0; y < SPR_H; y++)
        for (let x = 0; x < SPR_W; x++) {
            let c = pix[y * SPR_W + x];
            if (!c) {
                const edge = (x > 0 && pix[y * SPR_W + x - 1]) || (x < SPR_W - 1 && pix[y * SPR_W + x + 1]) ||
                             (y > 0 && pix[(y - 1) * SPR_W + x]) || (y < SPR_H - 1 && pix[(y + 1) * SPR_W + x]);
                if (!edge)
                    continue;
                c = line;
            }
            img.data.set([c[0], c[1], c[2], 255], (y * SPR_W + x) * 4);
        }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

/** Renders the checkered floor with a grain of lighter and darker pixels (in art pixels). */
function buildFloor(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = FIELD_W;
    canvas.height = FIELD_H;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(FIELD_W, FIELD_H);
    let r = 12345;
    for (let y = 0; y < FIELD_H; y++)
        for (let x = 0; x < FIELD_W; x++) {
            let c: Color = (Math.floor(x / CELL) + Math.floor(y / CELL)) % 2 ? C.FLOOR_A : C.FLOOR_B;
            r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
            if ((r >>> 24) < 14)
                c = mix(c, C.WHITE, 0.12);
            else if ((r >>> 24) > 244)
                c = mix(c, C.BLACK, 0.18);
            img.data.set([c[0], c[1], c[2], 255], (y * FIELD_W + x) * 4);
        }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

/** The top-left corner of a cell in art pixels. */
function cellXY(cell: number): [number, number] {
    return [FIELD_X + (cell % COLS) * CELL, FIELD_Y + Math.floor(cell / COLS) * CELL];
}

/** The center of a cell in screen pixels. */
export function cellCenter(cell: number): [number, number] {
    const [x, y] = cellXY(cell);
    return [(x + CELL / 2) * PIX, (y + CELL / 2) * PIX];
}

/** A text floating up from where something happened. */
interface FloatingText {
    x: number;
    y: number;
    /** Vertical speed in screen pixels per tick. */
    vy: number;
    size: number;
    color: Color;
    /** Ticks left. */
    life: number;
    text: string;
}

/** A confetti particle, in art pixels. */
interface Particle {
    life: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    color: Color;
}

/** A person to draw this frame (members of the line and guests are sorted by y together). */
interface Figure {
    x: number;
    y: number;
    look: number;
    legs: number;
    armsUp: boolean;
    hop: number;
    golden: boolean;
    /** The index in the line, or -1 for a guest. */
    member: number;
    /** The guest slot, or -1 for a member of the line. */
    slot: number;
}

/** The result of the last game as the title screen shows it. */
export interface LastScore {
    score: number;
    /** The id of its entry in the high score list, or null if it did not make it. */
    id: number | null;
    /** Its rank in the list (1 = best), or 0. */
    rank: number;
}

/** Draws the game, the title screen and the high score entry on a 640x480 canvas. */
export class Renderer {
    private readonly ctx: CanvasRenderingContext2D;
    private readonly looks = makeLooks();
    /** The sprites built so far, by look, frame and outline. */
    private readonly sprites = new Map<number, HTMLCanvasElement>();
    private readonly floor = buildFloor();
    /** Ticks since the start (drives all animations). */
    private ticks = 0;
    private fx: FloatingText[] = [];
    private parts: Particle[] = [];
    /** Ticks left of the "!" over each guest slot. */
    private readonly fleeMark = new Int32Array(MAX_GUESTS);
    private shake = 0;
    private screenFlash = 0;
    private livesFlash = 0;
    private comboFlash = 0;
    /** Ticks since the song was cleared (0: not cleared), for the light show. */
    private clearedTicks = 0;
    /** The offset of the world while the screen shakes, in screen pixels. */
    private sx = 0;
    private sy = 0;

    /**
     * @param canvas the 640x480 canvas
     * @param touch whether the texts should name the touch controls instead of the keys
     */
    constructor(canvas: HTMLCanvasElement, private readonly touch: boolean) {
        this.ctx = canvas.getContext('2d')!;
        this.ctx.imageSmoothingEnabled = false;
    }

    /** A text for keyboard or touch: the key with the suffix ".keys" or ".touch". */
    private control(key: string): string {
        return t(`${key}.${this.touch ? 'touch' : 'keys'}`);
    }

    /* ---- Primitives ---- */

    /** A rectangle in screen pixels. */
    private fill(x: number, y: number, w: number, h: number, c: Color): void {
        this.ctx.fillStyle = css(c);
        this.ctx.fillRect(x, y, w, h);
    }

    /** The border of a rectangle, t pixels thick. */
    private frameRect(x: number, y: number, w: number, h: number, t: number, c: Color): void {
        this.fill(x, y, w, t, c);
        this.fill(x, y + h - t, w, t, c);
        this.fill(x, y + t, t, h - 2 * t, c);
        this.fill(x + w - t, y + t, t, h - 2 * t, c);
    }

    /** A border with a soft glow around it. */
    private glowRect(x: number, y: number, w: number, h: number, t: number, c: Color): void {
        this.frameRect(x - 3, y - 3, w + 6, h + 6, t + 6, alpha(c, c[3] * 30 / 255));
        this.frameRect(x - 1.5, y - 1.5, w + 3, h + 3, t + 3, alpha(c, c[3] * 60 / 255));
        this.frameRect(x, y, w, h, t, c);
    }

    /** A rectangle in art pixels, moved by the screen shake. */
    private art(x: number, y: number, w: number, h: number, c: Color): void {
        this.fill(x * PIX + this.sx, y * PIX + this.sy, w * PIX, h * PIX, c);
    }

    /** A filled circle in art pixels, built from rows. */
    private artDisc(cx: number, cy: number, r: number, c: Color): void {
        for (let dy = -r; dy <= r; dy++) {
            const w = Math.floor(Math.sqrt(r * r - dy * dy) + 0.5);
            this.art(cx - w, cy + dy, 2 * w + 1, 1, c);
        }
    }

    /** The number of the current beat of the music. */
    private beat(): number {
        return Math.floor(this.ticks / BEAT_TICKS);
    }

    /** Text vertically centered on y; align -1: starts at x, 0: centered on x, 1: ends at x. */
    private text(x: number, y: number, size: number, c: Color, align: number, s: string): void {
        const ctx = this.ctx;
        ctx.font = `${size}px "Press Start 2P", monospace`;
        ctx.textAlign = align < 0 ? 'left' : align > 0 ? 'right' : 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = css(c);
        ctx.fillText(s, Math.round(x), Math.round(y + 1));
    }

    /** Text with its top at y and a dark shadow. */
    private label(x: number, y: number, size: number, c: Color, align: number, s: string): void {
        const d = size >= 32 ? 3 : size >= 16 ? 2 : 1;
        this.text(x + d, y + size / 2 + d, size, alpha(C.BLACK, c[3]), align, s);
        this.text(x, y + size / 2, size, c, align, s);
    }

    /** A centered label. */
    private title(x: number, y: number, size: number, c: Color, s: string): void {
        this.label(x, y, size, c, 0, s);
    }

    /* ---- People ---- */

    /** The sprite of a look (built on first use). */
    private sprite(look: number, frame: number, golden: boolean): HTMLCanvasElement {
        const key = look * 8 + frame * 2 + (golden ? 1 : 0);
        let s = this.sprites.get(key);
        if (!s) {
            s = buildSprite(this.looks[look], frame, golden);
            this.sprites.set(key, s);
        }
        return s;
    }

    /** A person with the cell's top-left at (x, y) in art pixels, lifted by hop, with a shadow. */
    private person(x: number, y: number, look: number, legs: number, armsUp: boolean, hop: number,
                   golden: boolean): void {
        this.art(x + 3, y + 15, 10, 1, alpha(C.BLACK, 90));
        this.ctx.drawImage(this.sprite(look, (legs & 1) | (armsUp ? 2 : 0), golden),
                           (x - SPR_OX) * PIX + this.sx, (y - SPR_OY - hop) * PIX + this.sy,
                           SPR_W * PIX, SPR_H * PIX);
    }

    /* ---- Dance floor ---- */

    /** Floor tiles lighting up: a pattern to the beat, the steps of the line, the cleared show. */
    private drawLights(g: Game): void {
        const b = this.beat(), pulse = 1 - (this.ticks % BEAT_TICKS) / BEAT_TICKS;

        for (let c = 0; c < CELLS; c++) {
            const x = c % COLS, y = Math.floor(c / COLS);
            let a = 0, col = LIT[0];

            if (g.tile[c] !== TILE.FLOOR)
                continue;
            if ((x * 5 + y * 3 + b) % 23 === 0) {
                a = Math.floor(110 + 90 * pulse);
                col = LIT[(x + b) % 5];
            }
            if (this.clearedTicks && (x + y + b) % 3 === 0) {
                a = 150;
                col = LIT[(x * 2 + y + b) % 5];
            }
            if (!a)
                continue;
            const [ax, ay] = cellXY(c);
            this.art(ax, ay, CELL, CELL, alpha(col, a * 3 / 4));
            this.art(ax + 2, ay + 2, CELL - 4, CELL - 4, alpha(mix(col, C.WHITE, 0.3), a / 3));
            this.art(ax + 1, ay + 1, CELL - 2, 1, alpha(C.WHITE, a / 3));
        }
    }

    /** Light spots of a mirror ball, wandering over the floor. */
    private drawMirrorBall(): void {
        for (let i = 0; i < 16; i++) {
            const a = this.ticks * 0.012 + i * 0.4, r = 30 + (i * 37) % 80;
            const x = Math.trunc(FIELD_X + FIELD_W / 2 + Math.cos(a) * r * 1.6);
            const y = Math.trunc(FIELD_Y + FIELD_H / 2 + Math.sin(a) * r * 0.9);
            const v = Math.trunc(90 + 70 * Math.sin(this.ticks * 0.05 + i));
            if (x > FIELD_X && x < FIELD_X + FIELD_W - 2 && y > FIELD_Y && y < FIELD_Y + FIELD_H - 2)
                this.art(x, y, 2, 2, alpha(C.WHITE, v));
        }
    }

    /** The frame around the floor with running LED lights. */
    private drawFrameLights(): void {
        const seq = [LIT[0], LIT[1], LIT[2]], b = this.beat();

        this.art(FIELD_X - 4, FIELD_Y - 4, FIELD_W + 8, 4, C.FRAME_BG);
        this.art(FIELD_X - 4, FIELD_Y + FIELD_H, FIELD_W + 8, 4, C.FRAME_BG);
        this.art(FIELD_X - 4, FIELD_Y, 4, FIELD_H, C.FRAME_BG);
        this.art(FIELD_X + FIELD_W, FIELD_Y, 4, FIELD_H, C.FRAME_BG);
        for (let i = 0; i * 4 < FIELD_W + 4; i++) {
            const x = FIELD_X - 3 + i * 4;
            this.art(x, FIELD_Y - 3, 2, 2, seq[(i + b) % 3]);
            this.art(x, FIELD_Y + FIELD_H + 1, 2, 2, seq[(i + b + 1) % 3]);
        }
        for (let i = 0; i * 4 < FIELD_H; i++) {
            const y = FIELD_Y + 1 + i * 4;
            this.art(FIELD_X - 3, y, 2, 2, seq[(i + b + 2) % 3]);
            this.art(FIELD_X + FIELD_W + 1, y, 2, 2, seq[(i + b) % 3]);
        }
    }

    /* ---- Furniture ---- */

    /** The position of a cell within a horizontal run of the same furniture (0 = leftmost). */
    private runIndex(g: Game, c: number, t: number): number {
        let i = 0;
        while (c % COLS > 0 && g.tile[c - 1] === t) {
            c--;
            i++;
        }
        return i;
    }

    /** A part of the DJ desk: turntables and mixers take turns, with blinking lights. */
    private drawDjDesk(g: Game, c: number, x: number, y: number): void {
        const i = this.runIndex(g, c, TILE.DJ), b = this.beat();

        this.art(x, y + 2, CELL, CELL - 2, C.OUTLINE);
        this.art(x, y + 3, CELL, CELL - 4, rgb(0x1d1a2e));
        this.art(x, y + 3, CELL, 6, rgb(0x3b3560));
        this.art(x, y + 3, CELL, 1, rgb(0x5a5290));
        if (i % 2 === 1) {          // turntable
            const a = this.ticks * 0.15;
            this.artDisc(x + 8, y + 6, 3, rgb(0x0e0c16));
            this.art(x + 8, y + 6, 1, 1, C.PINK);
            this.art(x + 8 + Math.round(Math.cos(a) * 2), y + 6 + Math.round(Math.sin(a) * 2), 1, 1, rgb(0x8a84b0));
        } else {                    // mixer
            for (let k = 0; k < 3; k++) {
                this.art(x + 3 + k * 4, y + 5, 2, 2, rgb(0x15121c));
                this.art(x + 3 + k * 4, y + 5 + ((Math.floor(this.ticks / 10) + k + i) % 3 === 0 ? 1 : 0), 2, 1,
                         rgb(0xb0a8e0));
            }
        }
        for (let k = 0; k < 4; k++)
            this.art(x + 2 + k * 4, y + 12, 2, 1, LIT[(k + i + b) % 5]);
    }

    /** A round high table with a drink. */
    private drawTable(x: number, y: number): void {
        this.art(x + 6, y + 13, 4, 2, alpha(C.BLACK, 100));
        this.artDisc(x + 8, y + 8, 6, C.OUTLINE);
        this.artDisc(x + 8, y + 8, 5, rgb(0x5a4a7a));
        this.artDisc(x + 7, y + 7, 3, rgb(0x7a68a8));
        this.art(x + 9, y + 5, 2, 3, alpha(C.CYAN, 200));
        this.art(x + 10, y + 3, 1, 3, C.PINK);
    }

    /** A speaker whose cone pumps to the beat. */
    private drawSpeaker(x: number, y: number): void {
        const pulse = 1 - (this.ticks % BEAT_TICKS) / BEAT_TICKS;
        this.art(x, y, CELL, CELL, C.OUTLINE);
        this.art(x + 1, y + 1, CELL - 2, CELL - 2, rgb(0x15121f));
        this.art(x + 1, y + 1, CELL - 2, 1, rgb(0x3a3550));
        this.artDisc(x + 8, y + 9, 5, rgb(0x2a2540));
        this.artDisc(x + 8, y + 9, 3 + (pulse > 0.7 ? 1 : 0), rgb(0x3e3860));
        this.art(x + 7, y + 8, 2, 2, rgb(0x6a64a0));
        this.art(x + 7, y + 2, 2, 2, rgb(0x4a4570));
    }

    /** A part of the bar counter, with bottles and glasses taking turns. */
    private drawBar(c: number, x: number, y: number): void {
        this.art(x, y + 2, CELL, CELL - 2, C.OUTLINE);
        this.art(x, y + 3, CELL, CELL - 4, rgb(0x6b3a1a));
        this.art(x, y + 3, CELL, 3, rgb(0x8a4f25));
        this.art(x, y + 3, CELL, 1, rgb(0xb06a35));
        if (c % 2 === 0) {
            this.art(x + 4, y - 2, 2, 6, rgb(0x2d7a3a));
            this.art(x + 4, y - 3, 2, 1, rgb(0x1a1210));
            this.art(x + 9, y + 1, 3, 3, alpha(C.CYAN, 180));
        } else {
            this.art(x + 6, y - 1, 2, 5, rgb(0x8a3a1a));
            this.art(x + 6, y - 2, 2, 1, rgb(0xd0d0d0));
        }
    }

    private drawFurniture(g: Game): void {
        for (let c = 0; c < CELLS; c++) {
            const [x, y] = cellXY(c);
            switch (g.tile[c]) {
            case TILE.DJ: this.drawDjDesk(g, c, x, y); break;
            case TILE.TABLE: this.drawTable(x, y); break;
            case TILE.SPEAKER: this.drawSpeaker(x, y); break;
            case TILE.BAR: this.drawBar(c, x, y); break;
            }
        }
    }

    /** The DJ stands behind the middle of the desk and dances. */
    private drawDj(g: Game): void {
        for (let c = 0; c < CELLS; c++)
            if (g.tile[c] === TILE.DJ && this.runIndex(g, c, TILE.DJ) === 2) {
                const [x, y] = cellXY(c);
                this.person(x, y - 9, LOOK_DJ, 0, this.beat() % 2 === 0, this.ticks % BEAT_TICKS < 6 ? 1 : 0, false);
            }
    }

    /* ---- People on the floor ---- */

    /** The position between two cells, f from 0 (from) to 1 (to), in art pixels. */
    private lerpCell(from: number, to: number, f: number): [number, number] {
        const [fx, fy] = cellXY(from), [tx, ty] = cellXY(to);
        f = Math.min(1, Math.max(0, f));
        return [Math.floor(fx + (tx - fx) * f + 0.5), Math.floor(fy + (ty - fy) * f + 0.5)];
    }

    /** How far the line is into its current step, from 0 to 1. */
    private lineProgress(g: Game): number {
        if (!g.moving || g.phase !== PHASE.PLAY)
            return 1;
        return g.stepTimer / songGet(g.song).stepTicks;
    }

    /** The line and the guests, back to front, with their decorations. */
    private drawPeople(g: Game): void {
        const f = this.lineProgress(g), dance = g.phase === PHASE.CLEARED, d: Figure[] = [];

        for (let i = 0; i < g.length; i++) {
            const [x, y] = this.lerpCell(g.from[i], g.body[i], f);
            d.push({
                x, y, look: g.look[i], legs: (g.steps + i) % 2,
                armsUp: dance && (Math.floor(this.ticks / 15) + i) % 2 === 1,
                hop: g.moving && g.phase === PHASE.PLAY ? (f < 0.5 ? 1 : 0)
                    : dance ? (Math.floor(this.ticks / 8) + i) % 2 : 0,
                golden: false, member: i, slot: -1,
            });
        }
        g.guests.forEach((gu, s) => {
            if (!gu.active)
                return;
            if (gu.type === GUEST.STAR && gu.age > STAR_TICKS - 2 * TICK_HZ && Math.floor(this.ticks / 4) % 2)
                return;             // blinks before it leaves
            const [x, y] = this.lerpCell(gu.from, gu.cell, gu.moved / GUEST_STEP);
            const tt = Math.floor(this.ticks / 8) + s * 3 + gu.look;
            d.push({
                x, y, look: gu.look, legs: Math.floor(tt / 2) % 2,
                armsUp: gu.type === GUEST.SHY ? this.fleeMark[s] > 0 : Math.floor(tt / 4) % 2 === 1,
                hop: gu.type === GUEST.SHY ? 0 : (tt % 4 === 0 ? 1 : 0),
                golden: gu.type === GUEST.STAR, member: -1, slot: s,
            });
        });
        // farther back first; on the same row the end of the line before the leader
        d.sort((p, q) => p.y !== q.y ? p.y - q.y : q.member - p.member);

        for (const p of d) {
            if (p.golden) {                         // sparkles around a star
                const a = this.ticks * 0.1;
                for (let k = 0; k < 4; k++) {
                    const b = a + k * Math.PI / 2;
                    this.art(p.x + 7 + Math.trunc(Math.cos(b) * 10), p.y + 6 + Math.trunc(Math.sin(b) * 7), 2, 2,
                             k % 2 ? C.WHITE : C.GOLD);
                }
            }
            this.person(p.x, p.y, p.look, p.legs, p.armsUp, p.hop, p.golden);
            if (p.slot >= 0 && g.guests[p.slot].type === GUEST.SHY) {
                if (this.fleeMark[p.slot]) {         // "!"
                    this.art(p.x + 13, p.y - 9, 2, 4, C.YELLOW);
                    this.art(p.x + 13, p.y - 4, 2, 1, C.YELLOW);
                } else if ((Math.floor(this.ticks / 20) + p.slot) % 3 === 0) {     // nervous sweat
                    this.art(p.x + 13, p.y - 1, 1, 2, C.CYAN);
                }
            }
            if (p.member === 0 && g.phase === PHASE.CRASH)      // dizzy stars
                for (let k = 0; k < 3; k++) {
                    const b = this.ticks * 0.15 + k * 2.1;
                    this.art(p.x + 7 + Math.trunc(Math.cos(b) * 7), p.y - 4 + Math.trunc(Math.sin(b) * 2), 2, 2,
                             C.YELLOW);
                }
        }
    }

    /** Blinking arrows next to the waiting leader in the free directions. */
    private drawArrows(g: Game): void {
        if (g.phase !== PHASE.PLAY || g.moving || Math.floor(this.ticks / 15) % 2)
            return;
        for (let d = 0; d < 4; d++) {
            const c = nextCell(g.body[0], d as Dir);
            if (c < 0 || g.cellBlocked(c))
                continue;
            let [x, y] = cellXY(c);
            x += 8;
            y += 8;
            for (let k = 0; k < 4; k++)
                switch (d) {
                case DIR.RIGHT: this.art(x - 2 + k, y - 3 + k, 1, 7 - 2 * k, C.YELLOW); break;
                case DIR.LEFT: this.art(x + 1 - k, y - 3 + k, 1, 7 - 2 * k, C.YELLOW); break;
                case DIR.DOWN: this.art(x - 3 + k, y - 2 + k, 7 - 2 * k, 1, C.YELLOW); break;
                default: this.art(x - 3 + k, y + 1 - k, 7 - 2 * k, 1, C.YELLOW); break;
                }
        }
    }

    /** Everything below the status bar: floor, lights, furniture, people, confetti. */
    private drawWorld(g: Game): void {
        this.fill(0, 0, SCREEN_W, SCREEN_H, C.BLACK);
        this.drawFrameLights();
        this.ctx.drawImage(this.floor, FIELD_X * PIX + this.sx, FIELD_Y * PIX + this.sy, FIELD_W * PIX, FIELD_H * PIX);
        this.drawLights(g);
        this.drawDj(g);
        this.drawFurniture(g);
        this.drawMirrorBall();
        this.drawArrows(g);
        this.drawPeople(g);
        for (const p of this.parts)
            if (p.life > 0)
                this.art(Math.trunc(p.x), Math.trunc(p.y), 2, 2, alpha(p.color, p.life * 12));
        if (g.phase === PHASE.GAME_OVER)
            this.fill(0, HUD_H * PIX, SCREEN_W, SCREEN_H, alpha(C.BLACK, Math.min(g.timer * 3, 150)));
    }

    /* ---- Status bar ---- */

    /** A pixel heart of 14x12 screen pixels. */
    private heart(x: number, y: number, c: Color): void {
        const rows = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
        rows.forEach((row, r) => {
            for (let k = 0; k < 7; k++)
                if (row[k] === 'X')
                    this.fill(x + k * 2, y + r * 2, 2, 2, c);
        });
    }

    /** Score, the line against the song's target, the combo, the song and the lives. */
    private drawHud(g: Game): void {
        const s = songGet(g.song), followers = g.followers(), slots = Math.max(g.lives, LIVES_START);
        const part = Math.min(1, Math.max(0, followers / s.target));
        let combo: Color = g.combo >= 4 ? C.YELLOW : g.combo >= 2 ? C.PINK : C.DIM;

        this.fill(0, 0, SCREEN_W, HUD_H * PIX, C.HUD_BG);
        this.fill(0, HUD_H * PIX - 2, SCREEN_W, 2, C.HUD_LINE);

        this.label(16, 8, 8, C.LABEL, -1, t('hud.score'));
        this.label(16, 26, 24, C.WHITE, -1, String(g.score));

        this.label(232, 8, 8, C.LABEL, -1, t('hud.dancers'));
        this.label(232, 24, 16, followers >= s.target ? C.GREEN : C.CYAN, -1, `${followers}/${s.target}`);
        this.fill(232, 48, 120, 6, C.DIM);
        this.fill(232, 48, 120 * part, 6, followers >= s.target ? C.GREEN : C.CYAN);

        this.label(410, 8, 8, C.LABEL, 0, t('hud.combo'));
        if (this.comboFlash && Math.floor(this.comboFlash / 4) % 2)
            combo = C.WHITE;
        this.label(410, 24, 16, g.combo ? combo : C.DIM, 0, `X${Math.max(g.combo, 1)}`);
        if (g.comboTimer > 0)
            this.fill(380, 48, 60 * g.comboTimer / COMBO_TICKS, 6, combo);

        this.label(624, 8, 8, C.LABEL, 1, t('hud.song', { song: g.song }));
        for (let i = 0; i < slots; i++) {
            const alive = i < g.lives;
            let c: Color = alive ? C.PINK : C.DIM;
            if (alive && i === g.lives - 1 && this.livesFlash && Math.floor(this.livesFlash / 6) % 2)
                c = C.WHITE;
            this.heart(610 - (slots - 1 - i) * 20, 30, c);
        }
    }

    /* ---- Effects ---- */

    private fxText(x: number, y: number, vy: number, size: number, color: Color, life: number, text: string): void {
        this.fx.push({ x, y, vy, size, color, life, text });
    }

    /** A burst of confetti at a cell (art pixels). */
    private burst(cell: number, n: number, gold: boolean): void {
        const [x, y] = cellXY(cell);
        for (let k = 0; k < n; k++) {
            const a = k * 2.39996 + this.ticks * 0.3, v = 0.6 + (k % 4) * 0.25;
            this.parts.push({
                life: 20 + k % 8, x: x + 7, y: y + 6, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.4,
                color: gold ? (k % 2 ? C.GOLD : C.WHITE) : LIT[k % 5],
            });
        }
    }

    /** Starts the visual effects of a game event. */
    event(g: Game, e: GameEvent): void {
        const [x, y] = cellCenter(e.cell);
        switch (e.type) {
        case EV.SONG_START:
            this.parts = [];
            this.fleeMark.fill(0);
            this.shake = this.screenFlash = this.clearedTicks = 0;
            break;
        case EV.CATCH: {
            const star = e.index === GUEST.STAR, col = COMBO_COLOR[Math.min(5, Math.max(1, e.count))];
            this.burst(e.cell, star ? 16 : 10, star);
            this.fxText(x, y - 24, -0.6, e.count >= 3 || star ? 16 : 8, star ? C.GOLD : col, TICK_HZ, `+${e.points}`);
            if (e.count >= 2) {
                this.comboFlash = 30;
                this.fxText(x, y - 46, -0.6, 8, col, TICK_HZ, `X${e.count}`);
            }
            break;
        }
        case EV.FLEE:
            this.fleeMark[e.index] = FLEE_TICKS;
            break;
        case EV.STAR:
            this.burst(e.cell, 12, true);
            this.fxText(x, y - 30, -0.4, 8, C.GOLD, TICK_HZ, t('fx.star'));
            break;
        case EV.STAR_GONE:
            this.burst(e.cell, 6, true);
            break;
        case EV.CRASH:
            this.shake = SHAKE_TICKS;
            this.screenFlash = FLASH_TICKS;
            this.livesFlash = 2 * TICK_HZ;
            break;
        case EV.EXTRA_LIFE:
            this.livesFlash = 2 * TICK_HZ;
            this.fxText(CX, 240, -0.3, 24, C.GREEN, 2 * TICK_HZ, t('fx.extraLife'));
            break;
        case EV.CLEARED:
            this.clearedTicks = 1;
            for (let i = 0; i < g.length; i += 2)
                this.burst(g.body[i], 6, false);
            break;
        }
    }

    /** Advances the animations by one logic tick. */
    tick(): void {
        this.ticks++;
        for (let i = 0; i < MAX_GUESTS; i++)
            if (this.fleeMark[i])
                this.fleeMark[i]--;
        for (const p of this.parts) {
            p.life--;
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.04;
        }
        this.parts = this.parts.filter(p => p.life > 0);
        if (this.clearedTicks)
            this.clearedTicks++;
        if (this.shake)
            this.shake--;
        if (this.screenFlash)
            this.screenFlash--;
        if (this.livesFlash)
            this.livesFlash--;
        if (this.comboFlash)
            this.comboFlash--;
        for (const f of this.fx) {
            f.life--;
            f.y += f.vy;
        }
        this.fx = this.fx.filter(f => f.life > 0);
    }

    /** The floating texts, fading out at the end of their life. */
    private drawFx(): void {
        for (const f of this.fx) {
            const a = f.life < 20 ? f.life * 255 / 20 : 255;
            this.text(f.x + 2, f.y + 2, f.size, alpha(C.BLACK, a), 0, f.text);
            this.text(f.x, f.y, f.size, alpha(f.color, a), 0, f.text);
        }
    }

    /* ---- Info screens ---- */

    /** A dark box with a glowing border across the middle of the screen. */
    private panel(y: number, h: number, c: Color): void {
        this.fill(CX - 240, y, 480, h, alpha(C.HUD_BG, 235));
        this.glowRect(CX - 240, y, 480, h, 2, c);
    }

    /** True every other 20 ticks, for blinking texts. */
    private blink(): boolean {
        return Math.floor(this.ticks / 20) % 2 === 1;
    }

    /** The start of a song: its goal, and for the first song the rules. */
    private drawIntro(g: Game): void {
        const s = songGet(g.song), y = g.song === 1 ? 84 : 170;
        const start = this.control('intro.start');

        this.panel(y, g.song === 1 ? 384 : 140, C.PINK);
        this.title(CX, y + 18, 32, C.YELLOW, t('intro.title', { song: g.song }));
        this.title(CX, y + 64, 8, C.TEXT, t('intro.goal', { target: s.target }));
        if (g.song === 1) {
            const lines = [
                t('help.title'),
                '',
                this.control('help.steer'),
                this.control('help.pause'),
                '',
                t('help.catch'),
                t('help.combo'),
                t('help.shy'),
                t('help.star'),
                '',
                ...t('help.crash').split('\n'),
            ];
            lines.forEach((l, i) => this.title(CX, y + 102 + i * 18, 8, i === 0 ? C.CYAN : C.TEXT, l));
            if (g.timer >= SKIP_TICKS && this.blink())
                this.title(CX, y + 352, 8, C.YELLOW, start);
        } else {
            this.title(CX, y + 86, 8, C.CYAN, t('intro.faster'));
            if (g.timer >= SKIP_TICKS && this.blink())
                this.title(CX, y + 112, 8, C.YELLOW, start);
        }
    }

    /** A hint over the waiting leader (below it in the top rows). */
    private drawWaiting(g: Game): void {
        if (g.phase !== PHASE.PLAY || g.moving || Math.floor(this.ticks / 20) % 3 === 2)
            return;
        let [x, y] = cellCenter(g.body[0]);
        y += Math.floor(g.body[0] / COLS) < 2 ? 44 : -58;
        x = Math.min(SCREEN_W - 110, Math.max(110, x));
        this.fill(x - 96, y - 4, 192, 18, alpha(C.HUD_BG, 200));
        this.title(x, y, 8, C.YELLOW, this.control('waiting'));
    }

    private drawCrash(g: Game): void {
        if (g.timer < 10)
            return;
        this.panel(176, 120, C.RED);
        this.title(CX, 192, 32, C.RED, t('crash.title'));
        this.title(CX, 236, 16, C.TEXT, tn('crash.lives', g.lives));
        if (g.dropped > 0)
            this.title(CX, 266, 8, C.LABEL, tn('crash.dropped', g.dropped));
    }

    /** The summary of a cleared song: the parts of the bonus appear one after the other. */
    private drawCleared(g: Game): void {
        const next = songGet(g.song + 1), tt = g.timer - 40, rows = tt < 0 ? -1 : Math.floor(tt / 20), y = 92;

        if (tt < 0)
            return;
        this.panel(y, 368, C.GREEN);
        this.title(CX, y + 18, 24, C.GREEN, t('cleared.title', { song: g.song }));
        if (rows >= 1) {
            this.label(100, y + 72, 8, C.TEXT, -1, tn('cleared.line', g.bonusFollowers));
            this.label(540, y + 70, 16, C.WHITE, 1, `+${g.bonusLine}`);
        }
        if (rows >= 2) {
            this.label(100, y + 104, 8, C.TEXT, -1, t('cleared.song', { song: g.song }));
            this.label(540, y + 102, 16, C.WHITE, 1, `+${g.bonusSong}`);
        }
        if (rows >= 3) {
            this.label(100, y + 136, 8, C.TEXT, -1, t('cleared.perfect'));
            this.label(540, y + 134, 16, g.bonusPerfect ? C.WHITE : C.DIM, 1, `+${g.bonusPerfect}`);
        }
        if (rows >= 4) {
            this.fill(100, y + 164, 440, 2, C.DIM);
            this.label(100, y + 182, 8, C.TEXT, -1, t('cleared.total'));
            this.label(540, y + 178, 24, C.YELLOW, 1, String(g.score));
        }
        if (rows >= 5) {
            this.glowRect(CX - 200, y + 236, 400, 58, 2, C.CYAN);
            this.title(CX, y + 250, 8, C.CYAN, t('cleared.next', { song: g.song + 1 }));
            this.title(CX, y + 270, 8, C.LABEL, t('cleared.nextInfo', { target: next.target }));
            if (g.timer >= SKIP_TICKS)
                this.title(CX, y + 330, 8, C.YELLOW, this.control('cleared.continue'));
        }
    }

    private drawGameOver(g: Game): void {
        if (g.timer < 70)
            return;
        this.panel(150, 170, C.RED);
        this.title(CX, 172, 32, C.RED, t('gameover.title'));
        this.title(CX, 226, 16, C.TEXT, t('gameover.score', { score: g.score }));
        this.title(CX, 256, 8, C.LABEL, t('gameover.song', { song: g.song }));
    }

    private drawPause(): void {
        this.panel(160, 130, C.YELLOW);
        this.title(CX, 180, 24, C.YELLOW, t('pause.title'));
        this.title(CX, 226, 8, C.TEXT, this.control('pause.resume'));
        this.title(CX, 250, 8, C.LABEL, this.control('pause.quit'));
    }

    /** The info for the current phase of the game. */
    private drawInfo(g: Game): void {
        switch (g.phase) {
        case PHASE.INTRO: this.drawIntro(g); break;
        case PHASE.PLAY: this.drawWaiting(g); break;
        case PHASE.CRASH: this.drawCrash(g); break;
        case PHASE.CLEARED: this.drawCleared(g); break;
        case PHASE.GAME_OVER: this.drawGameOver(g); break;
        }
    }

    /* ---- Frames ---- */

    /** A frame of the running game. */
    drawGame(g: Game, paused: boolean): void {
        this.sx = this.sy = 0;
        if (this.shake) {
            this.sx = (((this.ticks * 7) % 5) - 2) * PIX * this.shake / SHAKE_TICKS;
            this.sy = (((this.ticks * 3) % 5) - 2) * PIX * this.shake / SHAKE_TICKS;
        }
        this.drawWorld(g);
        this.sx = this.sy = 0;
        this.drawHud(g);
        if (this.screenFlash)
            this.fill(0, 0, SCREEN_W, SCREEN_H, alpha(C.RED, 80 * this.screenFlash / FLASH_TICKS));
        this.drawFx();
        if (paused)
            this.drawPause();
        else
            this.drawInfo(g);
    }

    /** The background of the title and entry screens: the demo floor, darkened, under the logo. */
    private drawBackdrop(demo: Game): void {
        this.sx = this.sy = 0;
        this.drawWorld(demo);
        this.fill(0, 0, SCREEN_W, SCREEN_H, alpha(C.BLACK, 110));

        // logo: "POLONAISE" with a pink glow
        const ctx = this.ctx;
        ctx.save();
        ctx.shadowColor = css(C.PINK);
        ctx.shadowBlur = 18;
        this.text(CX, 70, 40, C.PINK, 0, 'POLONAISE');
        ctx.restore();
        this.title(CX, 104, 8, C.CYAN, t('title.tagline'));

        // a conga line dancing over the title
        const n = 7, tt = this.ticks;
        for (let i = 0; i < n; i++) {
            const x = 160 - 16 * (i - 3) + Math.round(Math.sin((tt - i * 8) * 0.05) * 3) - 8;
            this.person(x, 66 + ((Math.floor(tt / 8) + i) % 2), i === 0 ? 0 : 7 * i + 3,
                        (Math.floor(tt / 8) + i) % 2, Math.floor(tt / 15 + i) % 2 === 1 && i > 0, 0, false);
        }
    }

    /**
     * The title screen: the demo floor behind the logo, the best scores of this browser and
     * the result of the last game (its entry blinks in the list).
     */
    drawTitle(demo: Game, scores: readonly ScoreEntry[], last: LastScore | null): void {
        this.drawBackdrop(demo);

        this.panel(214, 196, C.CYAN);
        this.title(CX, 230, 16, C.YELLOW, t('title.scores'));
        if (!scores.length)
            this.title(CX, 290, 8, C.LABEL, t('title.noScores'));
        scores.slice(0, 5).forEach((s, i) => {
            const y = 262 + i * 26, mark = last !== null && s.id === last.id;
            const c = mark && this.blink() ? C.WHITE : mark ? C.YELLOW : C.TEXT;
            this.label(100, y, 16, c, -1, `${i + 1}.`);
            this.label(140, y, 16, c, -1, s.name.toLocaleUpperCase() || t('entry.anonymous'));
            this.label(456, y, 16, c, 1, String(s.score));
            this.label(544, y + 4, 8, mark ? C.YELLOW : C.LABEL, 1, t('title.song', { song: s.song }));
        });

        if (last)
            this.title(CX, 176, 16, last.rank === 1 ? C.YELLOW : C.TEXT,
                       t(last.rank === 1 ? 'title.record' : 'title.yourScore', { score: last.score }));
        if (this.blink())
            this.title(CX, 432, 16, C.YELLOW, this.control('title.start'));
        if (!this.touch)
            this.title(CX, 462, 8, C.LABEL, t('title.keys'));
    }

    /**
     * The high score entry: a panel around the HTML name input (at ENTRY_FORM) with the
     * rank and score of the game just ended.
     */
    drawEntry(demo: Game, rank: number, score: number): void {
        this.drawBackdrop(demo);

        this.panel(140, 220, C.YELLOW);
        this.title(CX, 158, 24, this.blink() ? C.WHITE : C.YELLOW, t('entry.title'));
        this.title(CX, 200, 8, C.TEXT, t('entry.rank', { rank, score }));
        this.title(CX, 226, 8, C.CYAN, t('entry.prompt'));
        this.glowRect(ENTRY_FORM.x - 4, ENTRY_FORM.y - 4, ENTRY_FORM.w + 8, ENTRY_FORM.h + 8, 2, C.CYAN);
        this.title(CX, 316, 8, C.LABEL, this.control('entry.hint'));
    }
}
