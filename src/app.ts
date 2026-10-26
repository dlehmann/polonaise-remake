/*
 * app.ts - the flow of the game in the browser: the title screen with a demo and
 * the best scores, a game, the name entry for a new high score; the loop at a
 * fixed 60 ticks per second; keyboard, mouse and touch input; the pause.
 *
 * Keys: arrows or WASD steer, Enter or Space continue (the cabinet's A button),
 * Escape or P pause (Q in the pause ends the game), M sound on/off, F fullscreen.
 * Touch: swipe to steer, tap to continue, a long press in the pause ends the game;
 * the buttons at the top right pause and switch the sound and the fullscreen (in
 * portrait there are none: a tap on the status bar pauses).
 */
import { Sound } from './audio';
import { HUD_HEIGHT, Renderer, SCREEN_H, type LastScore } from './draw';
import { DIR, type Dir, EV, Game, type GameEvent, TICK_HZ } from './game';
import { ScoreBoard } from './scores';
import { View } from './view';

/** Logic ticks per frame at most (after the tab was in the background, for instance). */
const MAX_CATCH_UP = 5;
/** Direction presses waiting for the next ticks. */
const KEY_QUEUE = 4;
/** The distance in CSS pixels a finger has to move for a swipe. */
const SWIPE_MIN = 24;
/** Milliseconds of a long press (ends the game in the pause). */
const LONG_PRESS = 700;
/** The key of the last name entered in the local storage. */
const NAME_KEY = 'polonaise.name';

/** Where keys are listened for: on the whole page, or only while the game has the focus. */
export type KeyboardScope = 'page' | 'focus';

const KEY_DIRS: Record<string, Dir> = {
    ArrowRight: DIR.RIGHT, ArrowDown: DIR.DOWN, ArrowLeft: DIR.LEFT, ArrowUp: DIR.UP,
    KeyD: DIR.RIGHT, KeyS: DIR.DOWN, KeyA: DIR.LEFT, KeyW: DIR.UP,
};

/** A finished game waiting for the player's name. */
interface PendingScore {
    score: number;
    song: number;
    rank: number;
}

/** A finger on the screen. */
interface TouchStart {
    x: number;
    y: number;
    time: number;
    /** It has already steered: lifting it is not a tap. */
    swiped: boolean;
}

/** Whether an element takes text input itself (its keys are not for the game). */
function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** Reads the last name entered (a suggestion for the next entry). */
function savedName(): string {
    try {
        return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
        return '';
    }
}

export class App {
    private readonly renderer: Renderer;
    private mode: 'title' | 'game' | 'entry' = 'title';
    private game: Game | null = null;
    private paused = false;
    /** The game playing by itself behind the title screen (it never gets input). */
    private demo = new Game(7);
    /** The result of the last game, for the title screen. */
    private last: LastScore | null = null;
    private pending: PendingScore | null = null;
    /** Direction presses for the next ticks, one per tick. */
    private keys: Dir[] = [];
    /** A was pressed since the last tick. */
    private confirmPressed = false;
    private touchStart: TouchStart | null = null;
    /** Time of the last frame and the logic time not yet ticked, in seconds. */
    private lastFrame = 0;
    private acc = 0;

    constructor(private readonly view: View, private readonly sound: Sound, private readonly scores: ScoreBoard,
                private readonly keyboard: KeyboardScope, touch: boolean, private readonly portrait: boolean) {
        this.renderer = new Renderer(view.canvas, touch);
        this.demo.startAt(2);
    }

    /** Connects the input and starts the loop. */
    start(): void {
        this.listen();
        this.lastFrame = performance.now();
        requestAnimationFrame(now => this.frame(now));
    }

    /* ---- Flow ---- */

    private startGame(): void {
        const game = new Game((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0);
        this.game = game;
        this.mode = 'game';
        this.paused = false;
        this.keys = [];
        this.confirmPressed = false;
        this.last = null;
        this.sound.startMusic();
        for (const e of game.events)
            this.playEvent(game, e);
    }

    /** Back to the title screen; a score good enough for the list asks for the name first. */
    private endGame(): void {
        const game = this.game;
        if (!game)
            return;
        this.game = null;
        this.mode = 'title';
        this.paused = false;
        this.sound.pause(false);
        this.demo = new Game(Date.now() >>> 0);
        this.demo.startAt(2 + Math.floor(Math.random() * 7));
        this.sound.startMusic();
        if (this.scores.qualifies(game.score)) {
            this.pending = { score: game.score, song: game.song, rank: this.scores.rankFor(game.score) };
            this.mode = 'entry';
            this.view.showEntry(savedName());
        } else {
            this.last = game.score > 0 ? { score: game.score, id: null, rank: 0 } : null;
        }
    }

    /** The name was entered: the score goes into the list and the title screen shows it. */
    private async submitEntry(): Promise<void> {
        const p = this.pending;
        if (!p)
            return;
        const name = this.view.entryInput.value.trim();
        this.pending = null;
        this.view.hideEntry();
        this.mode = 'title';
        this.view.root.focus({ preventScroll: true });
        try {
            localStorage.setItem(NAME_KEY, name);
        } catch { /* not remembered */ }
        const { entry, rank } = await this.scores.add(name, p.score, p.song);
        this.last = { score: p.score, id: entry.id, rank };
    }

    private setPaused(p: boolean): void {
        if (this.mode !== 'game' || this.paused === p)
            return;
        this.paused = p;
        this.keys = [];
        if (p)
            this.sound.play('pause');
        // let the pause sound start before the audio context stops
        setTimeout(() => {
            if (this.paused === p)
                this.sound.pause(p);
        }, p ? 150 : 0);
    }

    /** The sound and the visual effects of a game event. */
    private playEvent(game: Game, e: GameEvent): void {
        switch (e.type) {
        case EV.CATCH:
            this.sound.play(e.index === 2 ? 'catch-star' : `catch-${Math.min(5, Math.max(1, e.count))}`);
            break;
        case EV.GAME_OVER:
            this.sound.fadeMusic(1.5);
            this.sound.play('game-over');
            break;
        case EV.PLAY:
        case EV.GRACE:          // silent: only a real crash makes a sound
            break;
        default:
            this.sound.play(e.type);
        }
        this.renderer.event(game, e);
    }

    /* ---- Input ---- */

    /** Queues a direction for the next ticks. */
    private press(d: Dir): void {
        if (this.keys.length < KEY_QUEUE)
            this.keys.push(d);
    }

    /** A (Enter, Space, a tap or click): start, continue, end the pause. */
    private confirm(): void {
        if (this.mode === 'title')
            this.startGame();
        else if (this.mode === 'entry')
            this.view.entryInput.focus();
        else if (this.paused)
            this.setPaused(false);
        else
            this.confirmPressed = true;
    }

    private toggleFullscreen(): void {
        if (document.fullscreenElement)
            void document.exitFullscreen();
        else
            this.view.root.requestFullscreen?.().catch(() => {});
    }

    /** Whether a key event is meant for the game. */
    private wantsKey(ev: KeyboardEvent): boolean {
        if (ev.ctrlKey || ev.metaKey || ev.altKey || isEditable(ev.target))
            return false;
        if (this.keyboard === 'focus')
            return true;        // the listener sits on the game element
        // on the whole page: not while something else has the focus (a dialog, a link)
        const target = ev.target as Node | null;
        return !target || target === document.body || target === document.documentElement ||
            this.view.root.contains(target);
    }

    private onKey(ev: KeyboardEvent): void {
        if (!this.wantsKey(ev))
            return;
        this.sound.unlock();
        const d = KEY_DIRS[ev.code];
        if (d !== undefined) {
            ev.preventDefault();
            if (!ev.repeat && this.mode === 'game' && !this.paused)
                this.press(d);
            return;
        }
        if (ev.repeat)
            return;
        switch (ev.code) {
        case 'Enter':
        case 'NumpadEnter':
        case 'Space':
            ev.preventDefault();
            this.confirm();
            break;
        case 'Escape':
        case 'KeyP':
            this.setPaused(!this.paused);
            break;
        case 'KeyQ':
            if (this.paused)
                this.endGame();
            break;
        case 'KeyM':
            this.sound.toggleMute();
            break;
        case 'KeyF':
            this.toggleFullscreen();
            break;
        }
    }

    /** In portrait, whether a point (client pixels) is on the status bar, which pauses there. */
    private onHud(x: number, y: number): boolean {
        if (!this.portrait || this.mode !== 'game')
            return false;
        const r = this.view.canvas.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y < r.top + r.height * HUD_HEIGHT / SCREEN_H;
    }

    /** Touches on the controls (buttons, the name entry) are left to them. */
    private static onControl(ev: Event): boolean {
        return ev.target instanceof Element && ev.target.closest('button, input, form, a') !== null;
    }

    private onTouchStart(ev: TouchEvent): void {
        if (App.onControl(ev))
            return;
        this.sound.unlock();
        const touch = ev.changedTouches[0];
        this.touchStart = { x: touch.clientX, y: touch.clientY, time: performance.now(), swiped: false };
        ev.preventDefault();
    }

    /** Steers as soon as the finger has moved far enough (one direction per touch). */
    private onTouchMove(ev: TouchEvent): void {
        if (App.onControl(ev))
            return;
        ev.preventDefault();
        const s = this.touchStart, touch = ev.changedTouches[0];
        if (!s || s.swiped)
            return;
        const dx = touch.clientX - s.x, dy = touch.clientY - s.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN)
            return;
        s.swiped = true;
        if (this.mode === 'game' && !this.paused)
            this.press(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIR.RIGHT : DIR.LEFT) : (dy > 0 ? DIR.DOWN : DIR.UP));
    }

    /** A touch without a swipe is a tap (A), or a long press in the pause. */
    private onTouchEnd(ev: TouchEvent): void {
        if (App.onControl(ev))
            return;
        ev.preventDefault();
        const s = this.touchStart;
        this.touchStart = null;
        if (!s || s.swiped)
            return;
        if (this.paused && performance.now() - s.time >= LONG_PRESS)
            this.endGame();
        else if (this.onHud(s.x, s.y))
            this.setPaused(!this.paused);
        else
            this.confirm();
    }

    /** Registers all event listeners. */
    private listen(): void {
        const root = this.view.root, v = this.view;
        const keyTarget: EventTarget = this.keyboard === 'page' ? window : root;
        keyTarget.addEventListener('keydown', ev => this.onKey(ev as KeyboardEvent));

        const active = { passive: false };
        root.addEventListener('touchstart', ev => this.onTouchStart(ev), active);
        root.addEventListener('touchmove', ev => this.onTouchMove(ev), active);
        root.addEventListener('touchend', ev => this.onTouchEnd(ev), active);
        v.canvas.addEventListener('mousedown', ev => {
            this.sound.unlock();
            root.focus({ preventScroll: true });
            if (this.onHud(ev.clientX, ev.clientY))
                this.setPaused(!this.paused);
            else
                this.confirm();
        });

        // after a click the buttons give the focus back, so Enter and Space do not press them again
        const button = (b: HTMLButtonElement, action: () => void) => b.addEventListener('click', () => {
            this.sound.unlock();
            action();
            root.focus({ preventScroll: true });
        });
        button(v.pauseButton, () => this.setPaused(!this.paused));
        button(v.soundButton, () => this.sound.toggleMute());
        button(v.fullButton, () => this.toggleFullscreen());

        v.entryForm.addEventListener('submit', ev => {
            ev.preventDefault();
            void this.submitEntry();
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden)
                this.setPaused(true);
        });
        // the phone version pauses while the phone is held sideways (it shows a note then)
        if (this.portrait)
            window.matchMedia('(orientation: landscape) and (max-height: 500px)').addEventListener('change', ev => {
                if (ev.matches)
                    this.setPaused(true);
            });
        // the page can pause the game, e.g. when it opens a dialog over it
        root.addEventListener('polonaise:pause', () => this.setPaused(true));
    }

    /* ---- Loop ---- */

    /** One logic tick of what is on screen. */
    private tick(): void {
        const game = this.game;
        if (!game) {
            this.renderer.tick();
            return;
        }
        game.tick(this.keys.shift() ?? DIR.NONE, this.confirmPressed);
        this.confirmPressed = false;
        for (const e of game.events)
            this.playEvent(game, e);
        this.renderer.tick();
        if (game.done)
            this.endGame();
    }

    /** Runs the ticks due since the last frame and draws. */
    private frame(now: number): void {
        this.acc += (now - this.lastFrame) / 1000;
        this.lastFrame = now;
        if (this.paused) {
            this.acc = 0;
        } else {
            let n = 0;
            while (this.acc >= 1 / TICK_HZ && n < MAX_CATCH_UP) {
                this.tick();
                this.acc -= 1 / TICK_HZ;
                n++;
            }
            if (n === MAX_CATCH_UP)
                this.acc = 0;
        }
        if (this.game)
            this.renderer.drawGame(this.game, this.paused);
        else if (this.pending)
            this.renderer.drawEntry(this.demo, this.pending.rank, this.pending.score);
        else
            this.renderer.drawTitle(this.demo, this.scores.list(), this.last);
        this.view.update(this.mode === 'game', this.sound.muted);
        requestAnimationFrame(next => this.frame(next));
    }
}
