/*
 * i18n.ts - the texts of the game in the language of the browser.
 *
 * The texts live in JSON files next to the game: <base>locales/<code>.json, one
 * flat object of keys and texts per language. <base>locales/languages.json lists
 * the codes of the available languages (e.g. ["en", "de"]); a new language only
 * needs its file and its code in that list, no rebuild.
 *
 * The language is the first of the browser's preferred languages
 * (navigator.languages) that is available, matched exactly ("pt-BR") or by its
 * base language ("de" for "de-AT"); without a match it is English. English is
 * also the fallback for every key a language file lacks.
 *
 * Texts may contain placeholders like {score}, filled from the parameters of t().
 * Texts that depend on a number come in plural forms, keys with the suffixes of
 * Intl.PluralRules (".one", ".other", and ".zero", ".two", ".few", ".many" for
 * languages that have them); tn() picks the right one.
 */

/** The texts of one language: key -> text. */
export type Messages = Record<string, string>;

/** Values for the placeholders of a text. */
export type Params = Record<string, string | number>;

/** The language used when no preferred language of the browser is available. */
export const FALLBACK_LANGUAGE = 'en';

let language = FALLBACK_LANGUAGE;
let messages: Messages = {};
let fallback: Messages = {};
let plurals = new Intl.PluralRules(FALLBACK_LANGUAGE);

/** Fetches a JSON file; null if it is missing or broken. */
async function fetchJson<T>(url: string): Promise<T | null> {
    try {
        const r = await fetch(url);
        return r.ok ? await r.json() as T : null;
    } catch {
        return null;
    }
}

/**
 * Picks the language: the first wanted language that is available (exactly, or by its
 * base language), else the fallback. The comparison ignores case ("pt-br" is "pt-BR").
 */
export function pickLanguage(wanted: readonly string[], available: readonly string[]): string {
    const find = (code: string) => available.find(a => a.toLowerCase() === code.toLowerCase());
    for (const w of wanted) {
        const match = find(w) ?? find(w.split('-')[0]);
        if (match)
            return match;
    }
    return available.includes(FALLBACK_LANGUAGE) ? FALLBACK_LANGUAGE : available[0] ?? FALLBACK_LANGUAGE;
}

/**
 * Loads the texts in the best language for the browser.
 * @param base the URL of the folder that contains locales/ (ending in "/")
 * @param forced a language code that wins over the browser's preferences, if available
 * @returns the code of the language used
 */
export async function loadLanguage(base: string, forced?: string): Promise<string> {
    const available = await fetchJson<string[]>(`${base}locales/languages.json`) ?? [FALLBACK_LANGUAGE];
    const wanted = [...(forced ? [forced] : []), ...(navigator.languages ?? [navigator.language])];
    const code = pickLanguage(wanted, available);

    const [own, english] = await Promise.all([
        fetchJson<Messages>(`${base}locales/${code}.json`),
        code === FALLBACK_LANGUAGE ? null : fetchJson<Messages>(`${base}locales/${FALLBACK_LANGUAGE}.json`),
    ]);
    language = own ? code : FALLBACK_LANGUAGE;
    messages = own ?? english ?? {};
    fallback = english ?? {};
    try {
        plurals = new Intl.PluralRules(language);
    } catch { /* an unknown code: keep the English rules */ }
    return language;
}

/** The code of the language in use. */
export function currentLanguage(): string {
    return language;
}

/** Replaces the placeholders {name} in a text; unknown ones stay as they are. */
function fill(text: string, params?: Params): string {
    if (!params)
        return text;
    return text.replace(/\{(\w+)\}/g, (all, name: string) => name in params ? String(params[name]) : all);
}

/** The text for a key, in the current language, else in English, else the key itself. */
export function t(key: string, params?: Params): string {
    return fill(messages[key] ?? fallback[key] ?? key, params);
}

/**
 * The text for a key in the plural form for count (key.one, key.other, ...); {count}
 * is filled in as well as the other parameters. A language file without the exact form
 * falls back to its ".other" form before English is asked.
 */
export function tn(key: string, count: number, params?: Params): string {
    const all = { count, ...params };
    const forms = [`${key}.${plurals.select(count)}`, `${key}.other`];
    for (const table of [messages, fallback])
        for (const form of forms)
            if (form in table)
                return fill(table[form], all);
    return key;
}
