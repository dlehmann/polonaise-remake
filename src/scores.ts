/*
 * scores.ts - the high score list, kept in the IndexedDB of the browser.
 *
 * The database "polonaise" has one object store "scores" with an auto-increment
 * key; each record holds the name, the score, the song reached and the date. Only
 * the best MAX_SCORES records are kept. The list is read once at the start and then
 * kept in memory, so drawing it never waits for the database.
 *
 * Nothing leaves the browser. Without IndexedDB (blocked storage, some private
 * modes) the list lives in memory and is gone after a reload.
 */

/** One entry of the list. */
export interface ScoreEntry {
    /** The database key; it grows with every entry, so it also orders equal scores. */
    id: number;
    name: string;
    score: number;
    /** The song in which the game ended. */
    song: number;
    /** When the game ended, in milliseconds since 1970. */
    date: number;
}

/** A new entry and its place in the list (1 = best). */
export interface RankedEntry {
    entry: ScoreEntry;
    rank: number;
}

/** The number of entries kept. */
export const MAX_SCORES = 10;
/** The longest name, in characters. */
export const MAX_NAME = 10;

const DB_NAME = 'polonaise';
const DB_VERSION = 1;
const STORE = 'scores';
/** Where the versions before the IndexedDB kept the scores (moved over once). */
const LEGACY_KEY = 'polonaise.scores';

/** Best first; equal scores: the older one first. */
function byRank(a: ScoreEntry, b: ScoreEntry): number {
    return b.score - a.score || a.id - b.id;
}

/** Wraps an IndexedDB request in a promise. */
function done<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((ok, fail) => {
        request.onsuccess = () => ok(request.result);
        request.onerror = () => fail(request.error);
    });
}

/** Opens (and on the first visit creates) the database; null if the browser does not allow it. */
function openDatabase(): Promise<IDBDatabase | null> {
    return new Promise(ok => {
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch {
            ok(null);
            return;
        }
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
            importLegacy(store);
        };
        request.onsuccess = () => ok(request.result);
        request.onerror = () => ok(null);
        request.onblocked = () => ok(null);
    });
}

/** Moves the scores of older versions (local storage, without names) into the new store. */
function importLegacy(store: IDBObjectStore): void {
    try {
        const old = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]') as { id: number; score: number; song: number }[];
        for (const o of old)
            store.add({ name: '', score: o.score, song: o.song, date: o.id });
        localStorage.removeItem(LEGACY_KEY);
    } catch { /* nothing to import */ }
}

/** The high score list of this browser. */
export class ScoreBoard {
    /** The entries, best first. */
    private entries: ScoreEntry[] = [];
    /** Key for the entries while there is no database. */
    private nextId = 1;

    private constructor(private readonly db: IDBDatabase | null) {}

    /** Opens the list and reads its entries. */
    static async open(): Promise<ScoreBoard> {
        const board = new ScoreBoard(await openDatabase());
        if (board.db) {
            try {
                const tx = board.db.transaction(STORE, 'readonly');
                const all = await done(tx.objectStore(STORE).getAll()) as ScoreEntry[];
                board.entries = all.sort(byRank).slice(0, MAX_SCORES);
            } catch { /* an unreadable store: start empty */ }
        }
        return board;
    }

    /** The entries, best first. */
    list(): readonly ScoreEntry[] {
        return this.entries;
    }

    /** Whether a score would make it into the list. */
    qualifies(score: number): boolean {
        if (score <= 0)
            return false;
        return this.entries.length < MAX_SCORES || score > this.entries[MAX_SCORES - 1].score;
    }

    /** The rank a new score would get (after the equal scores already in the list). */
    rankFor(score: number): number {
        return this.entries.filter(e => e.score >= score).length + 1;
    }

    /** Adds an entry and removes those that drop out of the list; returns the new entry and its rank. */
    async add(name: string, score: number, song: number): Promise<RankedEntry> {
        const record = { name: name.slice(0, MAX_NAME), score, song, date: Date.now() };
        let entry: ScoreEntry = { id: this.nextId++, ...record };

        if (this.db) {
            try {
                const tx = this.db.transaction(STORE, 'readwrite');
                const id = await done(tx.objectStore(STORE).add(record)) as number;
                entry = { ...record, id };
            } catch { /* not saved: kept in memory only */ }
        }
        this.entries = [...this.entries, entry].sort(byRank);
        const rank = this.entries.indexOf(entry) + 1;
        const removed = this.entries.slice(MAX_SCORES);
        this.entries = this.entries.slice(0, MAX_SCORES);
        if (this.db && removed.length) {
            try {
                const store = this.db.transaction(STORE, 'readwrite').objectStore(STORE);
                for (const r of removed)
                    store.delete(r.id);
            } catch { /* they would be dropped on the next start anyway */ }
        }
        return { entry, rank };
    }
}
