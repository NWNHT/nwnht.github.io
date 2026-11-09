/* ------------------------------------------------------------------
 * store.js — event persistence and identity.
 *
 * A static page has no server, so state lives in localStorage. The URL
 * hash also carries a compact event list, which makes a timeline
 * shareable by link and makes the back button work.
 * ------------------------------------------------------------------ */

const Store = (() => {
  const KEY = 'timeline.events.v1';

  /* Distinct, colour-blind-friendly hues. Chosen so that neighbouring
   * lanes stay distinguishable and text on the dark rail is legible. */
  // Event colours. These are deliberately deeper and more saturated than
  // a dark-theme palette: they have to carry contrast against the cream
  // background for both the bar fills and the small tag dots.
  const PALETTE = [
    '#1f6fb2', '#c2571a', '#3f8f4a', '#7b4fa8', '#a8862a',
    '#1f8a8a', '#b83f74', '#4653a8', '#6d8b1f', '#b3402f',
    '#2a7fa8', '#8a45a8',
  ];

  function colorFor(seed) {
    // Stable hash so the same event keeps its colour across reloads.
    let h = 2166136261;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return PALETTE[Math.abs(h) % PALETTE.length];
  }

  function uid() {
    return 'e' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  /**
   * Serialise an event for storage / the URL. We keep the resolved dates
   * as plain fields rather than re-fetching, so a saved timeline works
   * offline and does not burn API requests on every load.
   */
  function serialize(e) {
    return {
      id: e.id,
      label: e.label,
      description: e.description || '',
      pageUrl: e.pageUrl || null,
      wikiTitle: e.wikiTitle || null,
      extract: e.extract || null,
      wikidataUrl: e.wikidataUrl || null,
      qid: e.qid || null,
      color: e.color,
      isSpan: !!e.isSpan,
      startY: e.startY,
      endY: e.endY,
      // Instant fields, so the label can be regenerated exactly.
      start: packInstant(e.start),
      end: packInstant(e.end),
      propLabel: e.propLabel || null,
      source: e.source || null,
      textContext: e.textContext || null,
    };
  }

  function packInstant(dt) {
    if (!dt) return null;
    return [dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s, dt.precision, dt.approx ? 1 : 0];
  }

  function unpackInstant(a) {
    if (!a) return null;
    return {
      y: a[0], mo: a[1], d: a[2], h: a[3], mi: a[4], s: a[5],
      precision: a[6], approx: !!a[7],
    };
  }

  function deserialize(o) {
    return {
      id: o.id,
      label: o.label,
      description: o.description,
      pageUrl: o.pageUrl,
      wikiTitle: o.wikiTitle || null,
      extract: o.extract || null,
      wikidataUrl: o.wikidataUrl,
      qid: o.qid,
      color: o.color,
      isSpan: o.isSpan,
      startY: o.startY,
      endY: o.endY,
      start: unpackInstant(o.start),
      end: unpackInstant(o.end),
      propLabel: o.propLabel,
      source: o.source,
      textContext: o.textContext || null,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(deserialize) : [];
    } catch {
      return [];
    }
  }

  function save(events) {
    try {
      localStorage.setItem(KEY, JSON.stringify(events.map(serialize)));
    } catch {
      /* storage full or disabled — the app still works for this session */
    }
  }

  /* ---- view preferences -------------------------------------------
   * How the timeline is drawn rather than what is on it: the scale mode
   * (adaptive vs fixed) and where labels sit (inline vs stacked). These
   * are stable habits, not per-link data, so they live in their own key
   * and are deliberately kept out of the URL hash — a shared link should
   * not impose the sender's layout on the recipient.
   */
  const PREFS_KEY = 'timeline.prefs.v1';

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const o = raw ? JSON.parse(raw) : null;
      return o && typeof o === 'object' ? o : {};
    } catch {
      return {};
    }
  }

  function savePrefs(patch) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
    } catch {
      /* ignore */
    }
  }

  /* ---- URL hash ----------------------------------------------------
   * Compact form: #e=<base64url of json> — linkable and shareable.
   *
   * The lead extract is deliberately stripped here: it can run to a
   * kilobyte per event and would produce unusable multi-thousand-char
   * links. It is re-fetched on demand when the detail panel opens.
   */
  function toHash(events) {
    const payload = events.map((e) => {
      const o = serialize(e);
      delete o.extract;
      delete o.textContext;
      return o;
    });
    return '#e=' + b64urlEncode(JSON.stringify(payload));
  }

  function fromHash(hash) {
    const m = String(hash || '').match(/[#&]e=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      const json = b64urlDecode(m[1]);
      const arr = JSON.parse(json);
      return Array.isArray(arr) ? arr.map(deserialize) : null;
    } catch {
      return null;
    }
  }

  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(s) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  return {
    PALETTE, colorFor, uid,
    serialize, deserialize, packInstant, unpackInstant,
    load, save, toHash, fromHash, KEY,
    loadPrefs, savePrefs, PREFS_KEY,
  };
})();

if (typeof module !== 'undefined') module.exports = Store;