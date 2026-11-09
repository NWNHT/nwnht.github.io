/* ------------------------------------------------------------------
 * wikidata.js — free, keyless, CORS-enabled sources of dated events.
 *
 * Two providers, both callable straight from a static page:
 *
 *   1. Wikidata  — best for *structured* dates. Every entity can carry
 *      P585 (point in time), P580 (start time), P582 (end time), and
 *      P17/P31 for context. Search via wbsearchentities.
 *
 *   2. Wikipedia — best for *narrative* events. We use the search API
 *      to find articles, then the REST summary endpoint for the lead
 *      extract, then run our own date parser over the text. Also gives
 *      us the canonical article URL the tag should link to.
 *
 * Neither needs an API key. Both send Access-Control-Allow-Origin: *.
 * ------------------------------------------------------------------ */

const Wiki = (() => {

  const WD = 'https://www.wikidata.org/w/api.php';
  const WP = 'https://en.wikipedia.org/w/api.php';
  const WP_REST = 'https://en.wikipedia.org/api/rest_v1';

  // Show the user something while slower calls finish.
  const cache = new Map();
  const inflight = new Map();

  const RETRY = { attempts: 4, baseDelay: 900, maxDelay: 60000 };

  /**
   * Request gate.
   *
   * Wikimedia's documented policy (mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)
   * asks clients to:
   *   - keep concurrency to 3 or fewer
   *   - respect the Retry-After header on 429
   *   - send a compliant User-Agent (browsers set their own; we are
   *     classified as the "web browser, unauthenticated" tier at
   *     200 req/min rather than the 10 req/min unidentified tier)
   *
   * Note that rate limiting is per *IP*, so everyone behind one NAT or
   * corporate proxy shares a budget. We therefore cache aggressively
   * (see `cache`) and serialise sends rather than firing in parallel.
   *
   * Wikimedia can also answer with HTTP 200 and a plain-text "You are
   * making too many requests" body, so a bare r.ok check is not enough.
   */
  const MAX_CONCURRENT = 2;
  const MIN_GAP_MS = 150;

  let active = 0;
  let lastSent = 0;
  const waiters = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function acquire() {
    while (active >= MAX_CONCURRENT) {
      await new Promise((r) => waiters.push(r));
    }
    active++;
    const gap = MIN_GAP_MS - (Date.now() - lastSent);
    if (gap > 0) await sleep(gap);
    lastSent = Date.now();
  }

  function release() {
    active--;
    const next = waiters.shift();
    if (next) next();
  }

  const RATE_LIMIT_RE = /too many requests|rate ?limit|temporarily unavailable/i;

  async function getJSON(url, { timeout = 15000 } = {}) {
    if (cache.has(url)) return cache.get(url);
    if (inflight.has(url)) return inflight.get(url);

    const p = (async () => {
      let lastErr;
      for (let attempt = 0; attempt < RETRY.attempts; attempt++) {
        await acquire();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
          const r = await fetch(url, {
            signal: ctrl.signal,
            headers: { Accept: 'application/json' },
          });
          const text = await r.text();

          if (r.status === 429 || r.status === 503) {
            throw retryable(`HTTP ${r.status}`, retryAfterMs(r));
          }
          if (RATE_LIMIT_RE.test(text.slice(0, 200))) {
            throw retryable('RATE_LIMIT', retryAfterMs(r));
          }
          if (!r.ok) {
            const e = new Error(`HTTP ${r.status}`);
            // 4xx other than 429 will not succeed on retry.
            if (r.status < 500) e.fatal = true;
            throw e;
          }
          const json = JSON.parse(text);
          cache.set(url, json);
          return json;
        } catch (err) {
          lastErr = err;
          if (err.fatal) throw err;
          if (attempt === RETRY.attempts - 1) break;
          const backoff = err.retryAfter != null
            ? err.retryAfter
            : Math.min(RETRY.maxDelay, RETRY.baseDelay * Math.pow(2, attempt));
          await sleep(backoff);
        } finally {
          clearTimeout(timer);
          release();
        }
      }
      throw lastErr;
    })().finally(() => { inflight.delete(url); });

    inflight.set(url, p);
    return p;
  }

  function retryable(msg, retryAfter) {
    const e = new Error(msg);
    e.retryAfter = retryAfter;
    return e;
  }

  /**
   * Read Retry-After (seconds, or an HTTP date). Falls back to the
   * policy's "at least five seconds" when the header is missing.
   */
  function retryAfterMs(res) {
    const h = res.headers && res.headers.get && res.headers.get('Retry-After');
    if (h) {
      const secs = Number(h);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY.maxDelay);
      const when = Date.parse(h);
      if (Number.isFinite(when)) {
        return Math.max(0, Math.min(when - Date.now(), RETRY.maxDelay));
      }
    }
    return 5000;
  }

  /* --- Wikidata ---------------------------------------------------- */

  function wdUrl(params) {
    const u = new URL(WD);
    u.searchParams.set('format', 'json');
    u.searchParams.set('origin', '*');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /**
   * searchWikidata(query, lang) -> [candidate]
   * A candidate = { source, id, label, description, url }
   */
  async function searchWikidata(query, lang = 'en') {
    const j = await getJSON(wdUrl({
      action: 'wbsearchentities',
      search: query,
      language: lang,
      uselang: lang,
      type: 'item',
      limit: '12',
    }));
    return (j.search || []).map((r) => ({
      source: 'wikidata',
      id: r.id,
      label: r.label || r.id,
      altLabels: r.aliases || [],
      description: r.description || '',
      url: `https://www.wikidata.org/wiki/${r.id}`,
      wikipediaTitle: null,
    }));
  }

  /**
   * fetchSeeds(qids) -> { [qid]: { claims, sitelinks, labels } }
   *
   * One batched call for up to 50 entities. Note the deliberate absence
   * of `languages=en`: on wbgetentities that parameter filters labels
   * down to nothing and you silently get labels:{}. Omitting it returns
   * every language and we read .en ourselves. `sitefilter=enwiki` is
   * safe and keeps the sitelinks payload small.
   */
  async function fetchSeeds(qids) {
    if (!qids.length) return {};
    const j = await getJSON(wdUrl({
      action: 'wbgetentities',
      ids: qids.slice(0, 50).join('|'),
      props: 'claims|sitelinks|labels',
      sitefilter: 'enwiki',
    }));
    return j.entities || {};
  }

  /**
   * Pick the best available label for an entity.
   *
   * `languages=en` on wbgetentities is unreliable — it frequently
   * returns an empty labels object, and with no filter at all English
   * is also sometimes omitted (Wikidata treats it as the request
   * default and drops it). Rather than depend on that, we try in order:
   * the enwiki sitelink title (always correct English), labels.en, then
   * any latin-script fallback so something readable is always shown.
   */
  function bestLabel(entity, fallback) {
    if (!entity) return fallback || null;
    const sl = entity.sitelinks && entity.sitelinks.enwiki && entity.sitelinks.enwiki.title;
    if (sl) return sl;
    const labels = entity.labels || {};
    if (labels.en && labels.en.value) return labels.en.value;
    for (const k of ['en-gb', 'en-ca', 'simple', 'de', 'fr', 'es', 'it', 'pt', 'nl']) {
      if (labels[k] && labels[k].value) return labels[k].value;
    }
    const first = Object.values(labels)[0];
    return (first && first.value) || fallback || null;
  }

  /* Claim value -> our instant. Wikidata time values look like:
   *   { time: '+1969-07-20T00:00:00Z', precision: 11, calendarmodel: ... }
   *   { time: '-000449-00-00T00:00:00Z', precision: 9 }
   * precision: 0=Ga 1=100Ma 2=10Ma 3=Ma 4=100ka 5=10ka 6=ka
   *            7=century 8=decade 9=year 10=month 11=day
   *            12=hour 13=minute 14=second
   */
  function claimToInstant(v) {
    if (!v || !v.time) return null;
    const m = v.time.match(/^([+-])(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    // A zero month/day means "unspecified", not January 1st.
    const mo = +m[3] || null;
    const d  = +m[4] || null;
    const h  = m[5] != null ? +m[5] : null;
    const mi = m[6] != null ? +m[6] : null;
    const s  = m[7] != null ? +m[7] : null;
    // Wikidata time strings carry an explicit sign, not a year-zero
    // convention. Verified against real data:
    //   Plato  P569 -> "-0427-05-07"  == 427 BC == astro -426
    //   Plato  P570 -> "-0347-00-00"  == 347 BC == astro -346
    // so long as the stored value is the literal "N BC" year:
    //   astro = 1 - wdYear   (427 BC -> 1 - 427 = -426)
    // CE years pass through unchanged (+1969 -> 1969).
    //
    // Caveat: pre-1582 values use calendarmodel Q1985786 (Julian). We
    // lay them out on a proleptic Gregorian axis, exactly as JS Date,
    // ISO 8601 and most timeline tools do. The offset is ~13 days,
    // invisible at any scale where you would place a Julian date.
    const wdYear = parseInt(m[2], 10);
    const y = sign < 0 ? 1 - wdYear : wdYear;

    let precision;
    switch (v.precision) {
      case 0: case 1: case 2: case 3: precision = T.P.MILLION; break;
      case 4: case 5: case 6: precision = T.P.YEAR; break;
      case 7: precision = T.P.CENTURY; break;
      case 8: precision = T.P.DECADE; break;
      case 9: precision = T.P.YEAR; break;
      case 10: precision = T.P.MONTH; break;
      case 11: precision = T.P.DAY; break;
      default: precision = T.P.HOUR; break;   // 12=hour 13=minute 14=second
    }

    // Zero out fields the stated precision says are meaningless. This is
    // what stops "980" from rendering as "1 January 980".
    return {
      y,
      mo: precision >= T.P.MONTH ? mo : null,
      d:  precision >= T.P.DAY ? d : null,
      h:  precision >= T.P.HOUR ? h : null,
      mi: precision >= T.P.HOUR ? mi : null,
      s:  precision >= T.P.SECOND ? s : null,
      precision,
      approx: false,
    };
  }

  // Coarse Wikidata precise values carry extra scale info we can use.
  function claimScale(v) {
    if (!v) return 0;
    switch (v.precision) {
      case 0: return 1e9;
      case 1: return 1e8;
      case 2: return 1e7;
      case 3: return 1e6;
      case 4: return 1e5;
      case 5: return 1e4;
      case 6: return 1e3;
      default: return 0;
    }
  }

  function claims(entity, prop) {
    return (entity.claims && entity.claims[prop]) || [];
  }

  /**
   * Time-bearing properties, in priority order, grouped into
   * point-dates and start/end pairs.
   *
   * Why not just P585/P580/P582? Because the obvious ones are often
   * absent. Apollo 11 (Q43653) carries no P585 at all — its only dates
   * are P619 (launch) and P620 (landing). Covering a broad set is the
   * difference between a demo and something you can actually use.
   */
  const POINT_PROPS = [
    'P585',   // point in time              — the canonical "when"
    'P575',   // time of discovery or invention
    'P577',   // publication date
    'P619',   // UTC date of spacecraft launch
    'P620',   // UTC date of spacecraft landing
    'P606',   // first flight
    'P1619',  // date of official opening
    'P571',   // inception                   — weaker: an org's founding
    'P576',   // dissolved / abolished
    'P746',   // date of disappearance
    // People and other lived things. Without these, searching a person
    // (Caesar, Curie, Plato) returns "no date found", which is one of
    // the most common things anyone types into a timeline search box.
    // Birth and death are also a natural span, so they double as the
    // start/end pair below.
    'P569',   // date of birth
    'P570',   // date of death
  ];

  const START_PROPS = [
    // Only genuine start/end pairs. P571/P576 (inception/dissolved) are
    // deliberately absent here: for a single work they are often the same
    // fact at different precisions, which produced degenerate spans like
    // "1500s -> 1500s" for the Mona Lisa. They are handled separately
    // below (INCEPTION_PAIR) and only accepted when they are far enough
    // apart to be two distinct events.
    ['P580', 'P582'],   // start time / end time      — a real interval
    ['P729', 'P730'],   // service entry / retirement — a real interval
    ['P569', 'P570'],   // birth / death              — a lifespan
  ];

  /**
   * Inception (P571) and dissolved/abolished (P576) as a start/end pair.
   *
   * For a civilization, empire or other long-lived entity these are two
   * genuinely different events - the Maya run 2000 BC to 1521 AD - and
   * treating inception alone as a point throws away two millennia of
   * extent. But for a single artwork or building the two properties often
   * record the same moment at different precisions, which is what made
   * this pair unsafe and why it is gated on separation.
   */
  const INCEPTION_PAIR = ['P571', 'P576'];

  /**
   * Minimum years between inception and dissolution before the pair is
   * trusted as a span rather than one fact recorded twice. Wide enough to
   * reject the same-moment case, narrow enough to keep short-lived states.
   */
  const MIN_INCEPTION_SPAN_YEARS = 2;

  // Which property actually supplied the date — shown in the UI so the
  // user can tell "point in time" from "publication date".
  const PROP_LABEL = {
    P585: 'point in time', P575: 'discovered/invented', P577: 'published',
    P619: 'launched', P620: 'landed', P606: 'first flight',
    P1619: 'officially opened', P571: 'inception', P576: 'dissolved',
    P746: 'disappeared', P580: 'start', P582: 'end',
    P729: 'entered service', P730: 'retired',
    P569: 'born', P570: 'died',
  };

  /**
   * extractDates(entity) -> { point, start, end, prop, scale, conflicts }
   *
   * Collects every usable date, then picks the best. `conflicts` holds
   * the runner-up dates so the UI can offer them — Wikidata often has
   * several candidate dates for the same subject (e.g. launch vs
   * landing) and the right one is a matter of intent, not fact.
   */
  function extractDates(entity) {
    const found = [];

    for (const prop of POINT_PROPS) {
      for (const c of claims(entity, prop)) {
        const v = valueOf(c);
        const inst = claimToInstant(v);
        if (!inst) continue;
        found.push({ inst, prop, scale: claimScale(v), order: POINT_PROPS.indexOf(prop) });
      }
    }

    // Wikidata frequently stores the same date twice, once coarse and
    // once precise (the UN has both "1945" and "24 October 1945" for
    // inception). Within one property and kind, keep only the most
    // precise statement near the same time.
    const deduped = [];
    for (const f of found) {
      const fy = T.instantToYear(f.inst);
      const dup = deduped.find((g) => {
        if (g.prop !== f.prop) return false;
        const gy = T.instantToYear(g.inst);
        // Same property, and the coarser claim's whole extent covers the
        // finer one — i.e. they describe the same fact at two precisions.
        const [gs, ge] = T.extent(g.inst);
        const [fs, fe] = T.extent(f.inst);
        return fs >= gs - 1e-9 && fe <= ge + 1e-9;
      });
      if (!dup) { deduped.push(f); continue; }
      if (f.inst.precision > dup.inst.precision) {
        deduped[deduped.indexOf(dup)] = f;
      }
    }

    const spans = [];
    for (const [sProp, eProp] of START_PROPS) {
      const sVals = claims(entity, sProp).map(valueOf).filter(Boolean);
      const eVals = claims(entity, eProp).map(valueOf).filter(Boolean);
      for (const sv of sVals) {
        const st = claimToInstant(sv);
        if (!st) continue;
        // pair with the end closest after the start, if any
        let bestEnd = null, bestDelta = Infinity;
        for (const ev of eVals) {
          const en = claimToInstant(ev);
          if (!en) continue;
          const delta = T.instantToYear(en) - T.instantToYear(st);
          if (delta >= 0 && delta < bestDelta) { bestDelta = delta; bestEnd = { inst: en, prop: eProp }; }
        }
        spans.push({ start: st, end: bestEnd ? bestEnd.inst : null,
                     prop: sProp, endProp: bestEnd ? bestEnd.prop : null,
                     scale: claimScale(sv), order: START_PROPS.findIndex(p => p[0] === sProp) });
      }
    }

    // Inception/dissolution, accepted only when the two dates are far
    // enough apart to be separate events rather than one fact stored
    // twice. Ranked after the explicit intervals above but before the
    // bare point dates, since a real interval beats a lone instant.
    {
      const [sProp, eProp] = INCEPTION_PAIR;
      const sVals = claims(entity, sProp).map(valueOf).filter(Boolean);
      const eVals = claims(entity, eProp).map(valueOf).filter(Boolean);
      for (const sv of sVals) {
        const st = claimToInstant(sv);
        if (!st) continue;
        let bestEnd = null, bestDelta = Infinity;
        for (const ev of eVals) {
          const en = claimToInstant(ev);
          if (!en) continue;
          const delta = T.instantToYear(en) - T.instantToYear(st);
          if (delta >= MIN_INCEPTION_SPAN_YEARS && delta < bestDelta) {
            bestDelta = delta; bestEnd = { inst: en, prop: eProp };
          }
        }
        // No qualifying dissolution means this is just an inception date;
        // it already appears among the point dates, so skip it here.
        if (!bestEnd) continue;
        spans.push({ start: st, end: bestEnd.inst,
                     prop: sProp, endProp: eProp,
                     scale: claimScale(sv), order: START_PROPS.length });
      }
    }

    // Prefer an explicit span (it carries the most information), then
    // the highest-priority point date.
    const bestSpan = spans.sort((a, b) => a.order - b.order)[0] || null;
    const bestPoint = deduped.sort((a, b) => a.order - b.order)[0] || null;

    const primary = bestSpan || bestPoint || { inst: null, prop: null, scale: 0 };

    // Everything else becomes an alternative the user can switch to.
    const alternatives = [];
    for (const f of deduped) {
      if (bestPoint && f.inst === bestPoint.inst && f.prop === bestPoint.prop) continue;
      alternatives.push({ kind: 'point', inst: f.inst, prop: f.prop, label: PROP_LABEL[f.prop] || f.prop });
    }
    for (const s of spans) {
      if (bestSpan && s.start === bestSpan.start) continue;
      alternatives.push({ kind: 'span', start: s.start, end: s.end, prop: s.prop, label: PROP_LABEL[s.prop] || s.prop });
    }

    const scales = [primary.scale || 0, ...deduped.map(f => f.scale), ...spans.map(s => s.scale)];

    return {
      point: bestSpan ? null : primary.inst,
      start: bestSpan ? primary.start : null,
      end: bestSpan ? primary.end : null,
      prop: primary.prop,
      propLabel: PROP_LABEL[primary.prop] || null,
      scale: scales.length ? Math.max.apply(null, scales) : 0,
      alternatives,
    };
  }

  function valueOf(claim) {
    if (!claim || !claim.mainsnak) return null;
    if (claim.mainsnak.snaktype !== 'value') return null;
    return claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
  }

  /* --- Wikipedia ---------------------------------------------------- */

  async function searchWikipedia(query, lang = 'en') {
    const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    u.searchParams.set('action', 'query');
    u.searchParams.set('format', 'json');
    u.searchParams.set('origin', '*');
    u.searchParams.set('list', 'search');
    u.searchParams.set('srsearch', query);
    u.searchParams.set('srlimit', '12');
    u.searchParams.set('srprop', 'snippet');
    const j = await getJSON(u.toString());
    return ((j.query || {}).search || []).map((r) => ({
      source: 'wikipedia',
      id: r.title,
      label: r.title,
      description: stripTags(r.snippet || ''),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      wikipediaTitle: r.title,
    }));
  }

  function stripTags(s) {
    return s.replace(/<[^>]*>/g, '');
  }

  /**
   * wikiExtract(title) -> { title, extract, url, wikibase_item }
   * REST summary endpoint; also hands us the Wikidata Q-id so we can
   * upgrade a plain Wikipedia hit into structured dates for free.
   */
  async function wikiExtract(title, lang = 'en') {
    const url = `${WP_REST}/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const j = await getJSON(url);
    return {
      title: j.title,
      extract: j.extract,
      description: j.description,
      url: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || url,
      qid: j.wikibase_item || null,
      thumbnail: j.thumbnail ? j.thumbnail.source : null,
    };
  }

  /**
   * Date shapes we look for in prose.
   *
   * Order matters: the more specific patterns run first so that
   * "20 July 1969" is not partially consumed as the bare year "1969".
   *
   * The bare-year pattern is last but does the most work — "created
   * around 1040 AD" and "Around 1450, Johannes Gutenberg…" are the most
   * common date forms in Wikipedia leads, and without it the fallback
   * silently returns nothing.
   */
  const DATE_IN_TEXT = [
    // 20 July 1969 / 20th July 1969 / 20 July 1969 BC
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,4})\s*(BC|BCE|AD|CE)?\b/gi,
    // July 20, 1969
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{1,4})\b/gi,
    // 1969-07-20
    /\b(\d{3,4})-(\d{1,2})-(\d{1,2})\b/g,
    // the 5th century BC
    /\b(\d{1,2})(?:st|nd|rd|th)\s+century\s*(BC|BCE|AD|CE)?/gi,
    // a bare year, optionally with an era: "around 1040 AD", "in 1450"
    // Require a 3-4 digit number so we do not pick up counts, scores,
    // page numbers or quantities.
    /\b(\d{3,4})\s*(BC|BCE|AD|CE)\b|\b(\d{3,4})\b(?!\s*(?:km|kg|mi|million|billion|people|years))/g,
  ];

  /**
   * Context that makes a bare year unreliable as a standalone anchor.
   * "Between 1900 and 1950" or "from 1939 to 1945" describe a range;
   * emitting either endpoint as a point event misleads, and the range is
   * better expressed by the user adding both ends deliberately.
   */
  const RANGE_BEFORE = /(between|from|until|since|to|through|during|spanning|over the|and)\s*$/i;
  const RANGE_AFTER = /^\s*(?:[-–—]|to|until|and|through)\s*\d{3,4}\b/i;

  function datesFromText(text, limit = 6) {
    if (!text) return [];
    const out = [];
    const seen = new Set();

    for (const re of DATE_IN_TEXT) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) && out.length < limit) {
        const raw = m[0];
        const dt = T.parse(raw.trim());
        if (!dt) continue;

        const before = text.slice(Math.max(0, m.index - 24), m.index);
        const after = text.slice(m.index + raw.length, m.index + raw.length + 12);

        // A bare year that is really one end of a range: skip it. The
        // user can add both ends explicitly to see the span.
        if (dt.precision <= T.P.YEAR &&
            (RANGE_BEFORE.test(before) || RANGE_AFTER.test(after))) continue;

        // A bare year already covered by a more precise match ("15 April
        // 1912" implies "1912") adds nothing but clutter.
        if (dt.precision <= T.P.YEAR &&
            out.some((o) => o.instant.precision > T.P.YEAR &&
                            Math.floor(T.instantToYear(o.instant)) === Math.floor(T.instantToYear(dt)))) {
          continue;
        }

        const key = T.format(dt);
        if (seen.has(key)) continue;
        seen.add(key);

        const i = Math.max(0, m.index - 90);
        const j = Math.min(text.length, m.index + raw.length + 60);
        let ctx = text.slice(i, j).replace(/\s+/g, ' ').trim();
        if (i > 0) ctx = '…' + ctx;
        if (j < text.length) ctx = ctx + '…';

        out.push({ instant: dt, raw: raw.trim(), context: ctx });
      }
    }
    return out.sort((a, b) => T.instantToYear(b.instant) - T.instantToYear(a.instant));
  }

  /* --- combined search ---------------------------------------------- */

  /**
   * search(query) -> [candidate]
   * Runs Wikidata and Wikipedia in parallel and merges. Wikidata results
   * are preferred (structured dates); Wikipedia results are enriched
   * with the Q-id when the article has one.
   */
  async function search(query, { lang = 'en', signal } = {}) {
    const [wd, wp] = await Promise.allSettled([
      searchWikidata(query, lang),
      searchWikipedia(query, lang),
    ]);

    const wdList = wd.status === 'fulfilled' ? wd.value : [];
    const wpList = wp.status === 'fulfilled' ? wp.value : [];
    if (wd.status === 'rejected' && wp.status === 'rejected') {
      throw new Error('Search failed: both Wikidata and Wikipedia are unreachable.');
    }

    // Index Wikipedia results by normalized title so we can attach the
    // Q-id and page URL to a Wikidata hit with the same subject.
    const wpByTitle = new Map();
    for (const r of wpList) wpByTitle.set(r.label.toLowerCase(), r);

    const merged = [];
    const usedTitles = new Set();

    for (const r of wdList) {
      const wpHit = wpByTitle.get(r.label.toLowerCase());
      if (wpHit) {
        r.wikipediaTitle = wpHit.label;
        r.wpUrl = wpHit.url;
        r.wikipediaSnippet = wpHit.description;
        usedTitles.add(wpHit.label.toLowerCase());
      }
      merged.push(r);
    }
    for (const r of wpList) {
      if (usedTitles.has(r.label.toLowerCase())) continue;
      merged.push(r);
    }

    // Rank: exact-ish label match first, then subject-kind score, then
    // Wikidata (which carries dates). The label test stays dominant
    // because typing an exact title means you want that title; the score
    // only decides between candidates the query matches equally well,
    // which is exactly where "Roman Empire" the empire should beat
    // "Roman Empire" the 2016 documentary series.
    const q = query.trim().toLowerCase();
    const labelRank = (s) => (s === q ? 0 : s.startsWith(q) ? 1 : 2);
    merged.sort((a, b) => {
      const ea = labelRank(a.label.toLowerCase());
      const eb = labelRank(b.label.toLowerCase());
      if (ea !== eb) return ea - eb;
      const sa = subjectScore(a), sb = subjectScore(b);
      if (sa !== sb) return sb - sa;
      if (a.source !== b.source) return a.source === 'wikidata' ? -1 : 1;
      return 0;
    });

    return merged.slice(0, 16);
  }

  /**
   * resolve(candidate) -> event-ready payload
   *
   * Guarantees we return *something* usable: prefer Wikidata claims,
   * fall back to dates parsed out of the Wikipedia lead, and if all else
   * fails return a payload flagged `unresolved` so the UI can offer a
   * manual date entry instead of silently adding a dateless event.
   *
   * Request budget matters here — Wikimedia rate-limits per IP and every
   * click costs. We use at most two requests, issued in parallel:
   *   - the Wikidata entity, when we know or can find a Q-id
   *   - the Wikipedia summary, which also carries the Q-id and the
   *     article URL
   * A wikidata-sourced candidate knows its Q-id already, and a
   * wikipedia-sourced candidate gets its Q-id from the summary, so the
   * "find the Q-id" lookup is only a last resort.
   */
  async function resolve(candidate, { lang = 'en' } = {}) {
    let qid = candidate.source === 'wikidata' ? candidate.id : null;
    let entity = null;
    let extract = null;
    let wikiTitle = candidate.wikipediaTitle || null;
    let pageUrl = candidate.wpUrl || candidate.url;
    let description = candidate.description || '';

    const needEntity = !!qid;
    const needSummary = !!wikiTitle;

    const [entRes, sumRes] = await Promise.allSettled([
      needEntity
        ? fetchSeeds([qid]).then((m) => m[qid] || null)
        : Promise.resolve(null),
      needSummary ? wikiExtract(wikiTitle, lang) : Promise.resolve(null),
    ]);

    if (entRes.status === 'fulfilled') entity = entRes.value;
    if (sumRes.status === 'fulfilled' && sumRes.value) {
      const ex = sumRes.value;
      extract = ex.extract;
      if (ex.description && !description) description = ex.description;
      if (ex.url) pageUrl = ex.url;
      if (ex.qid && !qid) qid = ex.qid;
    }

    // A Wikipedia-only candidate learned its Q-id from the summary; fetch
    // the claims now. This is the one case that costs a second round trip.
    if (!entity && qid) {
      try {
        const m = await fetchSeeds([qid]);
        entity = m[qid] || null;
      } catch { /* offline — fall back to text dates */ }
    }

    if (entity) {
      const sl = entity.sitelinks && entity.sitelinks.enwiki;
      if (sl) {
        wikiTitle = sl.title;
        pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(sl.title.replace(/ /g, '_'))}`;
      }
      const label = bestLabel(entity, candidate.label);
      if (label) candidate.label = label;
      description = (entity.descriptions && entity.descriptions.en && entity.descriptions.en.value) || description;
    }

    // If we have a title but no summary yet (wikidata-sourced candidate),
    // fetch one — it powers the detail panel.
    if (!extract && wikiTitle) {
      try {
        const ex = await wikiExtract(wikiTitle, lang);
        extract = ex.extract;
        if (ex.url) pageUrl = ex.url;
      } catch { /* non-fatal */ }
    }

    const dates = entity
      ? extractDates(entity)
      : { point: null, start: null, end: null, scale: 0, prop: null, propLabel: null, alternatives: [] };

    // Only fall back to text mining when Wikidata gave us nothing usable.
    const fromText = dates.point || dates.start ? [] : datesFromText(extract, 8);

    return {
      qid,
      label: candidate.label,
      description,
      pageUrl,
      wikiTitle,
      wikidataUrl: qid ? `https://www.wikidata.org/wiki/${qid}` : null,
      extract,
      point: dates.point,
      start: dates.start,
      end: dates.end,
      prop: dates.prop,
      propLabel: dates.propLabel,
      alternatives: dates.alternatives || [],
      scale: dates.scale,
      fromText,
      unresolved: !dates.point && !dates.start && !fromText.length,
    };
  }

  /**
   * previewDates(qids) -> { [qid]: { start, end, isSpan, propLabel } }
   *
   * Cheap, batched date lookup for search results. A result list is much
   * easier to choose from when each row says which dates it would put on
   * the timeline, but resolving candidates one at a time would mean a
   * dozen round trips per keystroke. One wbgetentities call covers up to
   * 50 entities, so the whole visible list costs a single request.
   *
   * Only entities that yield a usable date come back, so callers can use
   * the absence of a key to render "no date found" rather than showing an
   * empty slot.
   */
  async function previewDates(qids) {
    const ids = [...new Set(qids.filter(Boolean))];
    if (!ids.length) return {};
    let entities = {};
    try {
      entities = await fetchSeeds(ids);
    } catch {
      return {};          // offline or rate-limited: rows just show no date
    }
    const out = {};
    for (const qid of ids) {
      const entity = entities[qid];
      if (!entity) continue;
      let dates;
      try {
        dates = extractDates(entity);
      } catch {
        continue;
      }
      if (!dates || (!dates.point && !dates.start)) continue;
      const start = dates.start || dates.point;
      const end = dates.start ? dates.end : null;
      out[qid] = {
        start,
        end,
        isSpan: !!(start && end && end.y !== start.y),
        propLabel: dates.propLabel || null,
      };
    }
    return out;
  }

  /**
   * What kind of thing a Wikidata description says we are looking at.
   *
   * A search for "Roman Empire" returns the civilization, a 2016
   * documentary series, and a video game — all titled identically. The
   * user almost always wants the one that happened, not one that was made
   * about it later. Descriptions are already in the search payload, so
   * this classification is free.
   */
  const WORK_KINDS = [
    /\b(documentary|film|movie|television|tv|series|miniseries|episode|sitcom)\b/i,
    /\b(book|novel|novella|memoir|biography|anthology|comic|manga)\b/i,
    /\b(album|song|single|soundtrack|musical|opera|score)\b/i,
    /\b(video game|game|expansion|dlc|mod)\b/i,
    /\b(podcast|radio|programme|program|channel|network)\b/i,
    /\b(magazine|newspaper|journal|periodical|publication|comic book|webcomic)\b/i,
    /\b(play|musical theatre|stage|theatre production)\b/i,
    /\b(painting|sculpture|artwork|photograph|art series)\b/i,
    /\b(adaptation|remake|sequel|prequel|spin-off|franchise)\b/i,
    /\b(disambiguation|list|list article|category|template)\b/i,
  ];

  // Subjects that are themselves events, eras, states, or people: the
  // things a timeline is actually for.
  const SUBJECT_KINDS = [
    /\b(civilization|civilisation|empire|kingdom|dynasty|republic|state|country|nation|federation|confederation|caliphate|khanate|sultanate|duchy|principality|city-state)\b/i,
    /\b(war|battle|siege|conflict|revolution|rebellion|uprising|treaty|invasion|campaign|expedition|crusade)\b/i,
    /\b(era|period|age|epoch|prehistory|antiquity|century|millennium|timeline|history|prehistoric)\b/i,
    /\b(disaster|earthquake|eruption|famine|plague|pandemic|epidemic|flood|fire|crash)\b/i,
    /\b(event|incident|expedition|mission|landing|launch|discovery|invention|construction|foundation|establishment)\b/i,
    /\b(monarch|king|queen|emperor|empress|pharaoh|president|statesman|general|philosopher|scientist|explorer|artist|writer|composer|saint|prophet)\b/i,
    /\b(religion|mythology|movement|organization|organisation|institution|company|corporation|party|alliance|tribe|people|ethnic group)\b/i,
  ];

  /**
   * subjectScore(candidate) -> number, higher is more like a real subject
   *
   * Deliberately a nudge, not a filter: a documentary is still offered,
   * just not above the thing it documents. Works are also ranked above
   * nothing at all, and a strong label match always wins in the end, so a
   * user who genuinely wants the 2016 series still finds it near the top.
   */
  function subjectScore(candidate) {
    const desc = (candidate.description || '').trim();
    let score = 0;

    if (desc) {
      // Being a war, empire, era, person and so on is the strongest
      // signal there is that this belongs on a timeline, and it must
      // outweigh merely having dates.
      if (SUBJECT_KINDS.some((re) => re.test(desc))) score += 6.0;
      if (WORK_KINDS.some((re) => re.test(desc))) score -= 6.0;
    }

    // Dates are a useful confirming signal, but a magazine, a ship or a
    // treaty can all have a span too, so this stays well below the
    // subject test above.
    if (candidate.previewDates) {
      score += candidate.previewDates.isSpan ? 1.5 : 0.75;
    }

    // "Documentary series", "2023 video game" and friends read as
    // creations; a bare, unqualified description usually means the thing
    // itself. Only a weak signal, so it only breaks ties.
    if (/\b(19|20)\d{2}\b/.test(desc)) score -= 0.75;

    return score;
  }

  return {
    search, resolve, searchWikidata, searchWikipedia, wikiExtract,
    datesFromText, extractDates, claimToInstant, fetchSeeds, bestLabel,
    previewDates, subjectScore,
    POINT_PROPS, START_PROPS, PROP_LABEL,
    _cache: cache,
  };
})();

if (typeof module !== 'undefined') module.exports = Wiki;