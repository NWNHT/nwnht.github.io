/* ------------------------------------------------------------------
 * app.js — wires search, events, the timeline and the detail panel.
 * ------------------------------------------------------------------ */

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    search: $('search'),
    results: $('results'),
    canvas: $('canvas'),
    overlay: $('overlay'),
    viewport: $('viewport'),
    tooltip: $('tooltip'),
    empty: $('empty'),
    count: $('count'),
    spanInfo: $('span-info'),
    detail: $('detail'),
    detailBody: $('detail-body'),
    detailClose: $('detail-close'),
    hint: $('hint'),
    hintClose: $('hint-close'),
    btnFit: $('btn-fit'),
    btnZoomIn: $('btn-zoom-in'),
    btnZoomOut: $('btn-zoom-out'),
    btnClear: $('btn-clear'),
    btnList: $('btn-list'),
    rankRelevant: $('rank-relevant'),
    rankFame: $('rank-fame'),
    eventList: $('eventlist'),
    eventListBody: $('eventlist-body'),
    eventListItems: $('eventlist-items'),
    eventListCount: $('eventlist-count'),
    eventListEmpty: $('eventlist-empty'),
    eventListClose: $('eventlist-close'),
    eventListScrim: $('eventlist-scrim'),
    setPickerList: $('setpicker-list'),
    setPickerNote: $('setpicker-note'),
  };

  let events = [];
  let persistEnabled = false;

  /* ---- event construction ----------------------------------------- */

  /**
   * buildEvent(resolved) -> event | null
   *
   * `resolved` is Wiki.resolve() output. A result can carry structured
   * dates, text-mined dates, both, or neither. This decides what the
   * timeline draws.
   */
  function buildEvent(resolved) {
    const base = {
      id: Store.uid(),
      label: resolved.label,
      description: resolved.description || '',
      pageUrl: resolved.pageUrl || null,
      wikiTitle: resolved.wikiTitle || null,
      extract: resolved.extract || null,
      wikidataUrl: resolved.wikidataUrl || null,
      qid: resolved.qid || null,
      propLabel: resolved.propLabel || null,
      source: resolved.source || null,
      color: Store.colorFor(resolved.qid || resolved.label),
    };

    let start = null, end = null, isSpan = false;

    if (resolved.start) {
      // Wikidata gave us a genuine interval (war, lifespan, reign…).
      start = resolved.start;
      end = resolved.end || null;
      isSpan = !!end;
    } else if (resolved.point) {
      start = resolved.point;
      // A coarse point date ("1960s", "5th century BC") is really a
      // range, and reads far better as a bar than a pin.
      if (start.precision <= T.P.DECADE) {
        const [a, b] = T.extent(start);
        isSpan = true;
        end = { ...start, y: b, precision: T.P.YEAR };
        start = { ...start, y: a, precision: T.P.YEAR };
      }
    } else if (resolved.fromText && resolved.fromText.length) {
      // Text fallback: use the most precisely dated mention.
      const best = resolved.fromText.slice().sort(
        (a, b) => b.instant.precision - a.instant.precision
      )[0];
      start = best.instant;
      base.textContext = best.context;
      base.source = 'wikipedia-text';
    }

    if (!start) return { ...base, unresolved: true, start: null, end: null, isSpan: false };

    const startY = T.instantToYear(start);
    const endY = end ? T.instantToYear(end) : startY;

    return {
      ...base,
      start, end, isSpan,
      startY: Math.min(startY, endY),
      endY: Math.max(startY, endY),
      dateLabel: T.format(start, { long: true }),
      dateLabelShort: isSpan && end
        ? `${T.format(start).replace(/\.$/, '')} → ${T.format(end)}`
        : T.format(start),
      gapLabel: isSpan && end ? T.formatDuration(Math.abs(endY - startY)) : null,
    };
  }

  /* ---- rendering --------------------------------------------------- */

  const timeline = Timeline.create({
    canvas: els.canvas,
    overlay: els.overlay,
    onSelect: (e, ev) => {
      showDetail(e);
    },
    onRemove: (e) => removeEvent(e.id),
    onHover: (e) => { /* tooltip handled via overlay hover */ },
  });

  // Debug handle. Handy from the console and used by the browser smoke
  // tests; harmless to ship for a tool like this.
  window.__tl = timeline;
  window.__app = { state: () => events, refresh, toggleEventList, setEventListOpen, _loadSet: loadSet, _resolveSetEntry: resolveSetEntry,
    // Raw timeline-module state, for layout debugging (bar pixel extents).
    _tl: () => timeline.state };

  function refresh({ keepView = true } = {}) {
    timeline.setEvents(events, { keepView });
    els.empty.hidden = events.length > 0;
    els.count.textContent = events.length === 1 ? '1 event' : `${events.length} events`;
    updateSpanInfo();
    renderEventList();
    updateHash();
    // Persist on every mutation. Relying on beforeunload alone loses
    // data on mobile Safari and after a crash.
    if (persistEnabled) Store.save(events);
  }

  function updateSpanInfo() {
    if (events.length < 2) {
      els.spanInfo.textContent = events.length ? '—' : 'search to begin';
      return;
    }
    const sorted = events.slice().sort((a, b) => a.startY - b.startY);
    const total = sorted[sorted.length - 1].startY - sorted[0].startY;
    const slog = sorted.reduce((acc, e, i) => {
      if (i === 0) return acc;
      const g = e.startY - sorted[i - 1].startY;
      return g < acc.years ? { years: g, from: sorted[i - 1], to: e } : acc;
    }, { years: Infinity });

    const parts = [`spanning ${T.formatDuration(total)}`];
    // "closest pair: 0 seconds" is only ever noise - it means two events
    // share a start year, which a curated set does on purpose (the Space
    // Race and Sputnik both begin in 1957). Say nothing instead.
    if (slog.years !== Infinity && slog.years > 0 && sorted.length > 2) {
      parts.push(`closest pair: ${T.formatDuration(slog.years)}`);
    }
    els.spanInfo.textContent = parts.join(' · ');
  }

  function updateHash() {
    const h = events.length ? Store.toHash(events) : '';
    history.replaceState(null, '', h || location.pathname + location.search);
  }

  /* ---- search ------------------------------------------------------ */

  let searchSeq = 0;

  /**
   * How search results are ordered: 'relevant' or 'fame'.
   *
   * Kept in memory and mirrored to localStorage so the choice survives a
   * reload. It is a preference about how the user thinks, not about this
   * session, and having to re-pick it on every visit would be tedious.
   */
  const RANK_KEY = 'timeline.rank';
  let rankMode = 'relevant';
  try {
    const saved = localStorage.getItem(RANK_KEY);
    if (saved === 'relevant' || saved === 'fame') rankMode = saved;
  } catch { /* private mode / storage disabled: fall back to the default */ }

  /**
   * Reflect `rankMode` in the two buttons and, when asked, re-run the
   * current query. The active half is marked with `is-active` plus
   * `aria-pressed`, so the state is exposed to screen readers as well as
   * drawn on screen.
   */
  function applyRankMode({ rerun = true } = {}) {
    const fame = rankMode === 'fame';
    els.rankRelevant.classList.toggle('is-active', !fame);
    els.rankFame.classList.toggle('is-active', fame);
    els.rankRelevant.setAttribute('aria-pressed', String(!fame));
    els.rankFame.setAttribute('aria-pressed', String(fame));
    try { localStorage.setItem(RANK_KEY, rankMode); } catch { /* ignore */ }
    if (rerun && els.search.value.trim()) runSearch(els.search.value.trim());
  }

  // Switching modes re-runs the query immediately when one is typed, so
  // the list the user is looking at visibly reorders rather than waiting
  // for the next keystroke. Keyboard users get the same behaviour from
  // Enter/Space on the focused button.
  els.rankRelevant.addEventListener('click', () => {
    if (rankMode === 'relevant') return;
    rankMode = 'relevant';
    applyRankMode();
    els.search.focus();
  });
  els.rankFame.addEventListener('click', () => {
    if (rankMode === 'fame') return;
    rankMode = 'fame';
    applyRankMode();
    els.search.focus();
  });

  let debounceTimer = null;

  els.search.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = els.search.value.trim();
    if (q.length < 2) { hideResults(); return; }
    debounceTimer = setTimeout(() => runSearch(q), 320);
  });

  els.search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { hideResults(); els.search.blur(); return; }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const first = els.results.querySelector('.result');
      if (first) first.focus();
    }
  });

  els.results.addEventListener('keydown', (ev) => {
    const items = [...els.results.querySelectorAll('.result')];
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      (items[i + 1] || items[0]).focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (i <= 0) els.search.focus();
      else items[i - 1].focus();
    } else if (ev.key === 'Escape') {
      hideResults();
      els.search.focus();
    }
  });

  async function runSearch(q) {
    const seq = ++searchSeq;
    showStatus(rankMode === 'fame' ? 'Searching (by fame)…' : 'Searching…');
    let cands;
    try {
      cands = await Wiki.search(q, { rank: rankMode });
    } catch (err) {
      if (seq !== searchSeq) return;
      showMessage(
        'Search failed',
        'Wikidata and Wikipedia could not be reached. This tool needs an internet connection. You may also have hit Wikimedia\'s rate limit — wait a moment and try again.'
      );
      return;
    }
    if (seq !== searchSeq) return;

    if (!cands.length) {
      showMessage('No matches', `Nothing found for “${escapeHtml(q)}”. Try a different phrasing.`);
      return;
    }
    renderResults(cands);
  }

  function renderResults(cands) {
    els.results.innerHTML = '';
    for (const c of cands) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'result';
      row.innerHTML =
        `<span class="result-label">${escapeHtml(c.label)}</span>` +
        `<span class="result-src ${c.source}">${c.source === 'wikidata' ? 'Wikidata' : 'Wikipedia'}</span>` +
        `<span class="result-dates" hidden></span>` +
        (c.description ? `<span class="result-desc">${escapeHtml(c.description)}</span>` : '');
      row.addEventListener('click', () => addCandidate(c, row));
      els.results.appendChild(row);
    }
    els.results.hidden = false;
    hydrateDates(cands);
  }

  /**
   * Fill in each row's date chip once the dates are known. Rows are shown
   * immediately with the chip hidden, so the list never waits on the
   * network and the chip simply appears when it arrives. Showing the date
   * up front matters because a name alone rarely tells you which of two
   * matches is the one you want, and which dates would land on the axis.
   */
  async function hydrateDates(cands) {
    const qids = cands.filter((c) => c.source === 'wikidata').map((c) => c.id);
    if (!qids.length) return;
    let map;
    try {
      map = await Wiki.previewDates(qids);
    } catch {
      return;
    }
    const rows = els.results.querySelectorAll('.result');
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const row = rows[i];
      if (!row) continue;
      const chip = row.querySelector('.result-dates');
      if (!chip) continue;
      const d = c.source === 'wikidata' ? map[c.id] : null;
      if (!d) continue;
      const from = T.format(d.start);
      let text;
      if (d.isSpan && d.end) {
        text = `${from} → ${T.format(d.end)}`;
        chip.classList.add('is-span');
      } else {
        text = from;
      }
      chip.textContent = text;
      chip.hidden = false;
      // Carry the preview onto the candidate so the click adds exactly
      // what the row promised, with no second lookup in the common case.
      c.previewDates = d;
    }

    // The date preview often reveals that a candidate is a documentary or
    // a game rather than the historical subject itself, and that only
    // becomes knowable now. Re-sort so the timeline-worthy entries surface
    // above the works about them, then reorder the DOM to match.
    resortRows(cands, rows);
  }

  /**
   * Re-apply the search ranking now that dates are known, moving the
   * already-rendered rows into the new order. Keeping the same elements
   * means the appearing date chips do not flicker and any row the user is
   * hovering stays put under the cursor.
   *
   * The date lookup is also the first moment `fame` exists for rows that
   * arrived without it, so it doubles as the trigger for fame ordering.
   */
  function resortRows(cands, rows) {
    const q = (els.search.value || '').trim().toLowerCase();
    const labelRank = (s) => (s === q ? 0 : s.startsWith(q) ? 1 : 2);
    const fame = rankMode === 'fame';
    const score = (c) => {
      const f = c.fame != null ? c.fame : (c.previewDates && c.previewDates.fame) || 0;
      return fame ? f : Wiki.subjectScore(c);
    };
    const idx = cands
      .map((c, i) => ({ c, i, lr: labelRank((c.label || '').toLowerCase()), s: score(c) }))
      .sort((a, b) => (a.lr - b.lr) || (b.s - a.s) || (a.i - b.i));
    const frag = document.createDocumentFragment();
    for (const { i } of idx) if (rows[i]) frag.appendChild(rows[i]);
    els.results.appendChild(frag);
  }

  function showStatus(msg) {
    els.results.innerHTML = `<div class="result-status">${escapeHtml(msg)}</div>`;
    els.results.hidden = false;
  }

  function showMessage(title, body) {
    els.results.innerHTML =
      `<div class="result-status"><strong>${escapeHtml(title)}</strong><br>${body}</div>`;
    els.results.hidden = false;
  }

  function hideResults() {
    els.results.hidden = true;
    els.results.innerHTML = '';
  }

  /**
   * The tag whose box contains a viewport point, or null. Used when the
   * search list floats over the timeline: elementFromPoint returns the
   * opaque list, so it cannot tell us that a tag was underneath. A small
   * tolerance makes edge hits count, which matters because a tag is only
   * ~30px tall.
   */
  function tagUnderPoint(overlayEl, x, y, pad = 2) {
    for (const el of overlayEl.children) {
      if (el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (x >= r.left - pad && x <= r.right + pad &&
          y >= r.top - pad && y <= r.bottom + pad) return el;
    }
    return null;
  }

  // Clicking outside the search box dismisses the results list. That
  // click must not be swallowed: the list floats over the timeline, so a
  // click the user aimed at a tag could land on a result row instead, and
  // eating it made the detail panel appear to need two presses. Whenever
  // the pointer is outside the list's own rectangle (or lands on the list
  // region but was really aimed underneath), we close the list and then
  // re-deliver the click to whatever is actually below.
  //
  // Whether a click began inside the event list is decided in the capture
  // phase, before any handler can run. Removing an event re-renders the
  // list, which detaches the row that was clicked; by the time the bubble
  // phase arrives, `ev.target.closest('#eventlist')` is null and the panel
  // would close itself on the very click that was aimed at it.
  let clickBeganInEventList = false;
  document.addEventListener('click', (ev) => {
    clickBeganInEventList = !!(ev.target.closest && ev.target.closest('#eventlist'));
  }, true);
  document.addEventListener('click', (ev) => {
    // A click outside the event list closes it, but must NOT be consumed:
    // the same click should still select a tag, start a pan, or focus the
    // search box. The scrim is pointer-events:none so the timeline stays
    // fully interactive while the list is open, which means dismissal has
    // to be decided here, from the event target, rather than by an overlay
    // swallowing the press.
    if (els.eventList.classList.contains('open')) {
      const inPanel = clickBeganInEventList;
      const onToggle = ev.target.closest && ev.target.closest('#btn-list');
      if (!inPanel && !onToggle && ev.target !== els.eventListScrim) {
        setEventListOpen(false);
        // No `return` - the click continues to whatever it was aimed at.
      }
    }

    // Clicking the search field itself keeps the list open.
    if (ev.target.id === 'search') return;
    if (els.results.hidden) return;

    const x = ev.clientX, y = ev.clientY;
    const insideSearch = !!ev.target.closest('.search-wrap');
    const listRect = els.results.getBoundingClientRect();
    const overList = x >= listRect.left && x <= listRect.right &&
                     y >= listRect.top && y <= listRect.bottom;

    // A click on a result row is normally a selection. But the list
    // floats over the timeline, so a row can sit directly on top of a
    // tag the user was aiming at. When a tag lies under the pointer, the
    // tag wins: the user was reaching past the list, not into it. This
    // is what made the detail panel seem to need two clicks. The test is
    // geometric because elementFromPoint cannot see through the list.
    if (ev.target.closest('.result')) {
      const covered = tagUnderPoint(els.overlay, x, y);
      if (!covered) return;                    // a real result click
      hideResults();
      covered.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: ev.button,
      }));
      return;
    }

    if (!insideSearch) hideResults();

    // Re-deliver only when the list was actually covering the point.
    if (!(insideSearch && overList)) return;
    hideResults();
    const under = document.elementFromPoint(x, y);
    if (!under) return;
    const tag = under.closest && under.closest('.tag');
    if (tag) {
      tag.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: ev.button,
      }));
      return;
    }
    if (under.id === 'canvas') {
      // The canvas selects on the pointerup that ends an unmoved drag, so
      // replaying a synthetic gesture would mean faking pointer capture.
      // Ask the timeline directly what sits under the point instead.
      const r = under.getBoundingClientRect();
      if (typeof timeline.selectAt === 'function') timeline.selectAt(x - r.left, y - r.top);
    }
  });

  async function addCandidate(c, rowEl) {
    if (rowEl) { rowEl.classList.add('loading'); rowEl.disabled = true; }
    // Show a pending chip immediately so the click feels responsive.
    showStatus(`Resolving “${c.label}”…`);

    let resolved;
    try {
      resolved = await Wiki.resolve(c);
    } catch (err) {
      showMessage('Could not load that event', escapeHtml(String(err.message || err)));
      if (rowEl) { rowEl.classList.remove('loading'); rowEl.disabled = false; }
      return;
    }

    const ev = buildEvent({ ...resolved, source: c.source });

    if (ev.unresolved) {
      // Nothing dateable found. Offer the alternatives rather than
      // silently adding an event with no position.
      showUnresolved(ev, resolved);
      if (rowEl) { rowEl.classList.remove('loading'); rowEl.disabled = false; }
      return;
    }

    hideResults();
    els.search.value = '';
    els.search.focus();

    events.push(ev);
    refresh({ keepView: true });
    timeline.focus(ev.id);
    flash(ev.id);
  }

  /**
   * When no date could be determined, show what we did find and let the
   * user pick a text-mined date or enter one by hand.
   */
  function showUnresolved(ev, resolved) {
    const rows = (resolved.fromText || []).map((d, i) =>
      `<button class="pick" data-i="${i}">` +
        `<span class="pick-date">${escapeHtml(T.format(d.instant, { long: true }))}</span>` +
        `<span class="pick-ctx">${escapeHtml(d.context || '')}</span>` +
      `</button>`
    ).join('');

    els.results.innerHTML =
      `<div class="result-status unresolved">` +
        `<strong>No date found for “${escapeHtml(ev.label)}”.</strong>` +
        `<p>${escapeHtml(ev.description || '')}</p>` +
        (rows
          ? `<p class="muted">Dates mentioned in the article:</p><div class="picks">${rows}</div>`
          : `<p class="muted">Nothing date-like was found in the article either.</p>`) +
        `<p class="muted">Or type a date:</p>` +
        `<div class="manual">` +
          `<input type="text" id="manual-date" placeholder="e.g. 1969-07-20, July 1969, 5th century BC">` +
          `<button type="button" id="manual-add">Add</button>` +
        `</div>` +
      `</div>`;
    els.results.hidden = false;

    els.results.querySelectorAll('.pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = resolved.fromText[+btn.dataset.i];
        commitManually(ev, d.instant, d.context);
      });
    });

    const input = $('manual-date');
    if (input) {
      const commit = () => {
        const dt = T.parse(input.value);
        if (!dt) { input.classList.add('bad'); return; }
        commitManually(ev, dt, null);
      };
      $('manual-add').addEventListener('click', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
      input.focus();
    }
  }

  function commitManually(ev, instant, context) {
    const done = buildEvent({
      label: ev.label,
      description: ev.description,
      pageUrl: ev.pageUrl,
      wikidataUrl: ev.wikidataUrl,
      qid: ev.qid,
      point: instant,
      propLabel: context ? 'from article text' : 'entered manually',
      source: context ? 'wikipedia-text' : 'manual',
    });
    if (context) done.textContext = context;
    hideResults();
    els.search.value = '';
    events.push(done);
    refresh({ keepView: true });
    timeline.focus(done.id);
    flash(done.id);
  }

  function removeEvent(id) {
    const i = events.findIndex((e) => e.id === id);
    if (i < 0) return;
    events.splice(i, 1);
    hideDetail();
    refresh({ keepView: true });
  }

  /* ---- suggested sets (top of the left panel) ---------------------- */

  /**
   * Each set is a list of Wikipedia titles. We resolve them through the
   * same Wiki.resolve() the search box uses, so a loaded set is
   * indistinguishable from events added by hand: same dates, same links,
   * same colours. Entries may carry an explicit { start, end } where the
   * source is wrong or has nothing - sets.js explains each case.
   *
   * Resolution is network-bound, so the rows render immediately from
   * cheap data and only their date RANGES are filled in later. A range
   * needs every member resolved, so we do it in the background, a few
   * requests at a time, and cache per set.
   */
  // Two caches, because a picker row and a loaded set need different
  // things. `rangeCache` holds two numbers per set, cheap to get.
  // `setCache` holds the fully resolved events, which is only worth
  // paying for once the user actually clicks.
  const rangeCache = new Map();  // id -> { min, max, n } | { error }
  const setCache = new Map();    // id -> events[]

  /**
   * Set while a set the user asked for is loading.
   *
   * Every Wikimedia call shares one rate limiter (two at a time, 150 ms
   * apart) because the API blocks clients that burst. Background range
   * fetching therefore competes with the click the user is waiting on,
   * and can hold it up for many seconds. A single flag is enough to make
   * background work yield: it checks this between requests and stands
   * down until the foreground load has finished.
   */
  let setBusy = false;

  /**
   * Bounded-concurrency runner. Resolving a set is 1-3 network round
   * trips per entry, so doing it strictly one at a time left the ranges
   * trickling in for a minute. A small pool keeps the panel responsive
   * without stampeding the API - which matters, because Wikipedia will
   * start refusing requests if we open a hundred at once.
   */
  async function mapPool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try { out[i] = await fn(items[i]); } catch { out[i] = null; }
      }
    });
    await Promise.all(workers);
    return out;
  }

  /** Resolve one set entry to an event. A pinned entry skips the date the
   *  source would have given, but still resolves the article so the label,
   *  link and description come from Wikipedia rather than from sets.js. */
  async function resolveSetEntry(entry) {
    const resolved = await Wiki.resolve({ label: entry.title, wikipediaTitle: entry.title });

    let pinned = null;
    if (entry.start !== undefined) {
      const p = T.P.YEAR;
      pinned = {
        start: { y: entry.start, mo: null, d: null, h: null, mi: null, s: null, precision: p, approx: false },
        end: entry.end !== undefined && entry.end !== entry.start
          ? { y: entry.end, mo: null, d: null, h: null, mi: null, s: null, precision: p, approx: false }
          : null,
      };
    }

    const ev = buildEvent({
      ...resolved,
      ...(pinned || {}),
      label: entry.note || resolved.label || entry.title,
      source: 'set',
    });
    return ev && !ev.unresolved ? ev : null;
  }

  /**
   * Date range for a picker row.
   *
   * The full resolve() path is 1-3 round trips PER ENTRY, so dating all
   * eleven sets that way is ~300 requests. That is enough to stall behind
   * the browser's per-host connection limit and leave rows spinning for a
   * minute. A row only needs two numbers, so this takes the cheap road:
   * one batched title search, then one batched date fetch. Two requests
   * per set instead of thirty.
   *
   * Pinned entries are known already and cost nothing. This result only
   * labels the row - the dates that reach the timeline still come from
   * the full resolve when the set is loaded.
   */
  /**
   * Fetch one set's date range, but only when nothing more important is
   * happening. Bails out (and is retried later) rather than joining the
   * queue behind a foreground load.
   */
  async function setRange(set) {
    if (rangeCache.has(set.id)) return rangeCache.get(set.id);
    const job = (async () => {
      let min = Infinity, max = -Infinity;

      for (const e of set.events) {
        if (e.start === undefined) continue;
        min = Math.min(min, e.start);
        max = Math.max(max, e.end ?? e.start);
      }

      const loose = set.events.filter((e) => e.start === undefined);
      if (loose.length) {
        // title -> QID, then one bulk date lookup for all of them.
        //
        // This uses the same ranking as the search box rather than a raw
        // entity search, because a raw search happily returns the wrong
        // thing: "Pax Romana" comes back as a 2003 book, which would
        // date the whole set to the present day. Prefer an exact label
        // match, and fall back to the top-ranked candidate.
        const qids = [];
        for (const e of loose) {
          if (setBusy) return { deferred: true };
          try {
            const hits = await Wiki.search(e.title);
            const want = e.title.trim().toLowerCase();
            const exact = hits.find((h) => (h.label || '').trim().toLowerCase() === want);
            const pick = exact || hits.find((h) => h.qid || h.id);
            const q = pick && (pick.qid || pick.id);
            if (q) qids.push(q);
          } catch { /* skip this title */ }
        }

        const dates = await Wiki.previewDates(qids);
        for (const qid of Object.keys(dates)) {
          const d = dates[qid];
          const s = d.start ? d.start.y : (d.point ? d.point.y : null);
          if (s === null) continue;
          min = Math.min(min, s);
          max = Math.max(max, d.end ? d.end.y : s);
        }
      }

      return Number.isFinite(min)
        ? { min, max, n: set.events.length }
        : { error: 'No entry in this set could be dated.' };
    })();
    rangeCache.set(set.id, job);
    try {
      const r = await job;
      // A deferred run must not be cached, or the row would stay blank
      // forever. Drop it and let the retry pass call us again.
      if (r && r.deferred) {
        rangeCache.delete(set.id);
        return r;
      }
      rangeCache.set(set.id, r);
      return r;
    } catch (e) {
      rangeCache.delete(set.id);
      throw e;
    }
  }

  /** Full event list for a set, resolved the same way the search box does. */
  async function loadSet(set) {
    if (setCache.has(set.id)) return setCache.get(set.id);
    const job = (async () =>
      (await mapPool(set.events, 6, resolveSetEntry)).filter(Boolean))();
    setCache.set(set.id, job);
    try {
      const evs = await job;
      setCache.set(set.id, evs);
      return evs;
    } catch (e) {
      setCache.delete(set.id);
      throw e;
    }
  }

  /** Compact year range for a picker row, e.g. "753 BC \u2013 476 AD". */
  function rangeLabel(a, b) {
    const f = (y) => T.yearLabel(y, 1, true);
    return a === b ? f(a) : `${f(a)} \u2013 ${f(b)}`;
  }

  function renderSetPicker() {
    if (typeof SETS === 'undefined') return;
    const frag = document.createDocumentFragment();

    for (const set of SETS) {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'set-row';
      row.dataset.setId = set.id;
      row.title = set.blurb || set.name;

      const name = document.createElement('span');
      name.className = 'set-name';
      name.textContent = set.name;

      const meta = document.createElement('span');
      meta.className = 'set-meta';
      const range = document.createElement('span');
      range.className = 'set-range';
      range.textContent = 'calculating\u2026';
      const count = document.createElement('span');
      count.className = 'set-count';
      count.textContent = `${set.events.length} events`;
      meta.append(range, count);

      row.append(name, meta);
      row.addEventListener("click", () => applySet(set, row));
      li.appendChild(row);
      frag.appendChild(li);
    }
    els.setPickerList.replaceChildren(frag);
  }

  /**
   * Fill in each row's date range, lazily.
   *
   * This is not an optimisation for its own sake. Every Wikimedia request
   * goes through a limiter capped at two concurrent sends with a 150 ms
   * gap, deliberately, because the API blocks clients that burst. Eleven
   * sets is roughly a thousand calls, which at that rate takes minutes -
   * and because the limiter is global, an eager sweep makes a row the
   * user actually clicks wait behind it. So ranges are fetched only for
   * rows that are on screen, and only while the panel is open.
   *
   * A set whose range is unknown is still perfectly usable: the row
   * loads on click regardless, and the range fills in when it can.
   */
  let rangeObserver = null;
  let rangeQueue = [];
  let rangePumpRunning = false;

  /**
   * Work through queued range lookups one at a time.
   *
   * Serialised on purpose. The API limiter only allows two requests at
   * once, so asking for eleven ranges in parallel does not make them
   * arrive sooner - it just buries the user's next click under a heap of
   * queued background calls. One at a time keeps the panel responsive.
   */
  async function pumpRanges() {
    if (rangePumpRunning) return;
    rangePumpRunning = true;
    while (rangeQueue.length) {
      if (setBusy) { await new Promise((r) => setTimeout(r, 200)); continue; }
      const row = rangeQueue[0];
      if (!row.isConnected) { rangeQueue.shift(); continue; }
      const set = SETS.find((s) => s.id === row.dataset.setId);
      const range = row.querySelector('.set-range');
      const count = row.querySelector('.set-count');
      if (!set) { rangeQueue.shift(); continue; }

      let r = null;
      try { r = await setRange(set); } catch { r = null; }

      // Deferred because the user started a load - stay queued.
      if (r && r.deferred) { await new Promise((res) => setTimeout(res, 200)); continue; }
      rangeQueue.shift();

      if (!r || r.error) {
        range.textContent = 'unavailable';
        row.classList.add('error');
      } else {
        range.textContent = rangeLabel(r.min, r.max);
        count.textContent = `${r.n} events`;
      }
    }
    rangePumpRunning = false;
  }

  function fillSetRanges() {
    const rows = [...els.setPickerList.querySelectorAll('.set-row')];
    const enqueue = (row) => {
      if (row.dataset.rangeQueued) return;
      row.dataset.rangeQueued = '1';
      rangeQueue.push(row);
    };

    // Ask only for the rows about to be looked at. Cheaper on the API and
    // it means the top of the list is dated first, which is what a user
    // reads first.
    if (typeof IntersectionObserver === 'function') {
      if (!rangeObserver) {
        rangeObserver = new IntersectionObserver((entries, obs) => {
          for (const e of entries) {
            if (e.isIntersecting) { enqueue(e.target); obs.unobserve(e.target); }
          }
          pumpRanges();
        }, { root: els.eventListBody, rootMargin: '160px' });
      }
      rows.forEach((r) => rangeObserver.observe(r));
    } else {
      rows.forEach(enqueue);
    }
    pumpRanges();
  }

  /** Load every event in a set onto the timeline. */
  async function applySet(set, row) {
    if (row.classList.contains('loading')) return;
    row.classList.add('loading');
    row.disabled = true;
    setSetNote('');

    // A click is a user waiting, so stop fetching background ranges for
    // the moment. They queue behind the same global limiter, and at two
    // requests per 150 ms that wait is very noticeable.
    setBusy = true;

    let list;
    try {
      list = await loadSet(set);
    } catch (e) {
      console.error('set load failed', set.id, e);
      row.classList.remove('loading');
      row.disabled = false;
      row.classList.add('error');
      setSetNote(String(e.message || e));
      setBusy = false;
      pumpRanges();
      return;
    }
    setBusy = false;
    pumpRanges();

    row.classList.remove('loading');
    row.disabled = false;

    if (!list.length) {
      row.classList.add('error');
      setSetNote('No entry in this set could be dated.');
      return;
    }

    // Re-loading a set should top up what is missing, not duplicate the
    // whole thing. Label plus start year is enough to identify an event.
    const existing = new Set(events.map((e) => `${e.label}\u0000${e.startY}`));
    const fresh = list.filter((e) => !existing.has(`${e.label}\u0000${e.startY}`));
    if (!fresh.length) {
      row.classList.add('done');
      setSetNote(`All ${list.length} events from this set are already on the timeline.`);
      return;
    }

    events.push(...fresh.map((e) => ({ ...e, id: Store.uid() })));
    refresh({ keepView: false });
    row.classList.add('done');
    setSetNote(fresh.length === list.length
      ? ''
      : `Added ${fresh.length} of ${list.length} \u2014 the rest were already on the timeline.`);

    // The set is on the timeline now, so a pending range fetch is wasted
    // work. Fill the label from the events we already have instead.
    const r = await setRange(set).catch(() => null);
    if (r && !r.error) {
      row.querySelector('.set-range').textContent = rangeLabel(r.min, r.max);
      row.querySelector('.set-count').textContent = `${r.n} events`;
    }
  }

  function setSetNote(msg) {
    els.setPickerNote.textContent = msg || '';
    els.setPickerNote.hidden = !msg;
  }

  /* ---- event list (left slide-in) ---------------------------------- */

  /**
   * Render the list oldest-first, so time reads downward and the newest
   * event is at the bottom. Events sharing a start year are ordered by
   * the year they end, which keeps a span ahead of a point that starts in
   * the same year and stops the order flickering between renders.
   */
  function renderEventList() {
    const sorted = events.slice().sort(
      (a, b) => (a.startY - b.startY) || ((a.endY || a.startY) - (b.endY || b.startY))
    );

    els.eventListCount.textContent = String(events.length);
    els.eventListEmpty.hidden = events.length > 0;
    els.btnList.classList.toggle('has-events', events.length > 0);

    const frag = document.createDocumentFragment();
    for (const e of sorted) {
      const li = document.createElement('li');
      li.className = 'eventlist-item';
      li.dataset.id = e.id;

      const dot = document.createElement('span');
      dot.className = 'eventlist-dot';
      dot.style.setProperty('--dot', e.color || 'var(--accent)');

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'eventlist-label';
      label.textContent = e.label;
      label.title = `Centre the timeline on ${e.label}`;
      label.addEventListener('click', () => {
        timeline.focus(e.id);
        showDetail(e);
      });

      const date = document.createElement('span');
      date.className = 'eventlist-date';
      date.textContent = e.dateLabelShort || e.dateLabel || 'no date';

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'eventlist-remove';
      rm.textContent = '×';
      rm.setAttribute('aria-label', `Remove ${e.label}`);
      rm.title = `Remove ${e.label}`;
      rm.addEventListener('click', () => removeEvent(e.id));

      li.append(dot, label, date, rm);
      frag.appendChild(li);
    }
    els.eventListItems.replaceChildren(frag);

    // Keep the row for the open detail panel highlighted, so the list and
    // the panel agree about what is being looked at.
    const openId = els.detail.hidden ? null : els.detail.dataset.id;
    for (const li of els.eventListItems.children) {
      li.classList.toggle('is-open', !!openId && li.dataset.id === openId);
    }
  }

  function setEventListOpen(open) {
    els.eventList.classList.toggle('open', open);
    els.eventList.setAttribute('aria-hidden', String(!open));
    els.eventListScrim.classList.toggle('on', open);
    els.btnList.classList.toggle('on', open);
    els.btnList.setAttribute('aria-expanded', String(open));
    // Rows leave the tab order while the panel is off-screen.
    els.eventList.inert = !open;
    // Shift the timeline across so the panel does not hide the start of
    // the axis. The canvas watches its own box, so it re-layouts itself.
    document.body.classList.toggle('list-open', open);
    // Only now is it worth spending the API calls to date every set.
    if (open) fillSetRanges();
  }

  function toggleEventList() {
    setEventListOpen(!els.eventList.classList.contains('open'));
  }

  function flash(id) {
    const el = els.overlay.querySelector(`.tag[data-id="${id}"]`);
    if (!el) return;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 900);
  }

  /* ---- detail panel ------------------------------------------------ */

  function showDetail(e) {
    const sorted = events.slice().sort((a, b) => a.startY - b.startY);
    const ci = sorted.findIndex((x) => x.id === e.id);
    const prev = ci > 0 ? sorted[ci - 1] : null;
    const next = ci >= 0 && ci < sorted.length - 1 ? sorted[ci + 1] : null;

    const gapRow = (other, dir) => {
      if (!other) return '';
      const yrs = dir === 'prev'
        ? e.startY - other.startY
        : other.startY - e.startY;
      if (!(yrs > 0)) return '';
      return `<div class="gap-row">
        <span class="gap-dir">${dir === 'prev' ? 'after' : 'until'} ${escapeHtml(other.label)}</span>
        <span class="gap-val">${escapeHtml(T.formatDuration(yrs))}</span>
      </div>`;
    };

    els.detailBody.innerHTML =
      `<div class="detail-head">` +
        `<h2>${escapeHtml(e.label)}</h2>` +
        `<div class="detail-date">` +
          `<strong>${escapeHtml(e.dateLabel)}</strong>` +
          (e.isSpan && e.end ? ` <span class="muted">→ ${escapeHtml(T.format(e.end, { long: true }))}</span>` : '') +
          (e.propLabel ? ` <span class="chip">${escapeHtml(e.propLabel)}</span>` : '') +
        `</div>` +
        (e.isSpan && e.end
          ? `<div class="detail-dur">Lasted ${escapeHtml(T.formatDuration(Math.abs(e.endY - e.startY)))}</div>`
          : '') +
      `</div>` +
      `<div class="detail-body-cols">` +
        `<div class="detail-main">` +
          (e.description ? `<p class="detail-desc">${escapeHtml(e.description)}</p>` : '') +
          (e.extract ? `<p class="detail-extract">${escapeHtml(e.extract)}</p>` : '') +
          (e.textContext ? `<p class="detail-ctx">${escapeHtml(e.textContext)}</p>` : '') +
        `</div>` +
        `<div class="detail-side">` +
          `<div class="detail-gaps">${gapRow(prev, 'prev')}${gapRow(next, 'next')}</div>` +
          `<div class="detail-links">` +
            (e.pageUrl ? `<a href="${e.pageUrl}" target="_blank" rel="noopener noreferrer">Wikipedia ↗</a>` : '') +
            (e.wikidataUrl ? `<a href="${e.wikidataUrl}" target="_blank" rel="noopener noreferrer">Wikidata ↗</a>` : '') +
            (e.wikipediaSearchUrl ? `<a href="${e.wikipediaSearchUrl}" target="_blank" rel="noopener noreferrer">Search ↗</a>` : '') +
          `</div>` +
          `<button class="btn ghost remove" id="detail-remove">Remove from timeline</button>` +
        `</div>` +
      `</div>`;

    els.detail.hidden = false;
    els.detail.dataset.id = e.id;
    // Let the timeline reclaim its own layout. The panel docks at the
    // bottom; the viewport only gives up the space actually left over
    // after the timeline has everything it needs, so a short timeline in
    // a tall window doesn't get shoved upwards for no reason.
    document.body.classList.add('has-detail');
    syncPanelSpace();
    window.dispatchEvent(new Event('resize'));
    $('detail-remove').addEventListener('click', () => removeEvent(e.id));
    renderEventList();

    // Pull the lead extract if we have not already, so the panel has
    // substance without blocking the initial add.
    if (!e.extract && e.wikiTitle) {
      Wiki.wikiExtract(e.wikiTitle).then((ex) => {
        if (!ex || !ex.extract) return;
        e.extract = ex.extract;
        showDetail(e);
      }).catch(() => {});
    }
  }

  function hideDetail() {
    els.detail.hidden = true;
    delete els.detail.dataset.id;
    document.body.classList.remove('has-detail');
    document.body.style.removeProperty('--detail-h');
    window.dispatchEvent(new Event('resize'));
    renderEventList();
  }

  /**
   * Give the detail sheet the height it needs, and no more.
   *
   * The panel docks over the bottom of the window, so something has to
   * give. Rather than reserving a fixed slice of the viewport, we ask the
   * timeline how much vertical room it actually needs (which depends on
   * the lane count) and only shrink the viewport when the two genuinely
   * collide. With a couple of events in a tall window that means no
   * movement at all - the timeline stays exactly where it was and the
   * panel simply uses space that was empty anyway.
   */
  function syncPanelSpace() {
    if (els.detail.hidden) {
      document.body.style.removeProperty('--detail-h');
      return;
    }
    const shell = document.documentElement;
    const topbar = $('topbar') || document.querySelector('.topbar');
    const hintEl = $('hint');
    const status = document.querySelector('.statusbar');

    const topH = (topbar ? topbar.getBoundingClientRect().height : 0) +
      (hintEl && !hintEl.hidden ? hintEl.getBoundingClientRect().height : 0);
    const statusH = status ? status.getBoundingClientRect().height : 0;

    // Room the timeline wants, and the room left over once the panel is
    // placed. The panel never takes more than 45% of the window, and the
    // timeline never gives up more than 45%, so both stay usable.
    const avail = window.innerHeight - topH - statusH;
    const want = timeline.getContentHeight() || 0;
    const maxPanel = Math.round(avail * 0.45);
    const minTimeline = Math.round(avail * 0.30);

    // Panel height is content-driven: measure it with its natural height
    // by clearing the cap first.
    els.detail.style.setProperty('--detail-h', 'auto');
    const natural = els.detail.scrollHeight;
    let panelH = Math.min(natural, maxPanel);

    // If the timeline's ideal height plus the panel still fit, there is
    // no conflict: the timeline keeps every pixel the panel does not need
    // and the panel simply occupies space that was empty anyway. Both
    // reserve values are set explicitly - leaving the reserve at 0px let
    // the stylesheet's 220px floor take over, which collapsed the viewport
    // and opened a large dead band between the ruler and the panel.
    if (want + panelH <= avail) {
      document.body.style.setProperty('--detail-h', Math.round(panelH) + 'px');
      document.body.style.setProperty('--detail-reserve',
        Math.round(avail - panelH) + 'px');
      return;
    }

    // Otherwise, split the shortfall: give the timeline at least what it
    // needs to stay legible, and hand the rest to the panel.
    const timelineH = Math.max(minTimeline, Math.min(want, avail - panelH));
    panelH = Math.min(maxPanel, Math.max(0, avail - timelineH));
    document.body.style.setProperty('--detail-h', Math.round(panelH) + 'px');
    document.body.style.setProperty('--detail-reserve', Math.round(timelineH) + 'px');
  }
  els.detailClose.addEventListener('click', hideDetail);

  /* ---- controls ---------------------------------------------------- */

  // Paint the ranking toggle from the saved preference before anything
  // else. `rerun: false` because there is no query yet at startup.
  applyRankMode({ rerun: false });

  els.btnFit.addEventListener('click', () => timeline.fit());

  // --- scale and label configuration ------------------------------------
  // The chart has one fixed presentation: a linear axis, so distances are
  // directly comparable against the ruler, and stacked labels, so every
  // bar shares a baseline. There is no switcher for either any more, but
  // both are still set explicitly here rather than left to the module
  // defaults, because the module supports other modes internally and a
  // stale saved preference from an older build would otherwise be able to
  // restore 'adaptive' or 'inline' on a returning visitor.
  //
  // The stored keys are deliberately cleared, not merely ignored: leaving
  // them behind would keep a dead preference alive in localStorage for no
  // reader.
  timeline.setScaleMode('linear');
  timeline.setLabelMode('stacked');
  Store.savePrefs({ scaleMode: 'linear', labelMode: 'stacked' });

  els.btnZoomIn.addEventListener('click', () => timeline.zoomIn());
  els.btnZoomOut.addEventListener('click', () => timeline.zoomOut());

  // --- event list ---------------------------------------------------------
  els.btnList.addEventListener('click', toggleEventList);
  els.eventListClose.addEventListener('click', () => setEventListOpen(false));
  // The scrim carries no click listener: it is pointer-events:none so the
  // timeline stays interactive underneath, and dismissal is handled by
  // the document-level listener above.

  // --- clear, in two steps ------------------------------------------------
  // A blocking confirm() dialog is jarring and cannot be styled. Instead
  // the button arms itself: the first click turns it into "Confirm", and
  // only a second click wipes the timeline. The armed state is abandoned
  // if the user looks away - after a short pause, on Escape, or on a
  // click anywhere else - so a half-pressed Clear can never sit there
  // waiting to be finished off by an unrelated later click.
  const CLEAR_ARM_MS = 4000;
  let clearArmed = false;
  let clearTimer = 0;

  function disarmClear() {
    if (!clearArmed) return;
    clearArmed = false;
    clearTimeout(clearTimer);
    clearTimer = 0;
    els.btnClear.textContent = 'Clear';
    els.btnClear.classList.remove('armed');
    els.btnClear.setAttribute('title', 'Remove all events');
    els.btnClear.setAttribute('aria-label', 'Remove all events');
  }

  function armClear() {
    clearArmed = true;
    els.btnClear.textContent = 'Confirm';
    els.btnClear.classList.add('armed');
    const n = events.length;
    const what = n === 1 ? 'the event' : `all ${n} events`;
    els.btnClear.setAttribute('title', `Click again to remove ${what}`);
    els.btnClear.setAttribute('aria-label', `Confirm removing ${what}`);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(disarmClear, CLEAR_ARM_MS);
  }

  els.btnClear.addEventListener('click', (ev) => {
    // Nothing to clear: do not offer a confirmation for a no-op.
    if (!events.length) { disarmClear(); return; }
    if (!clearArmed) { armClear(); return; }
    // Stop the document-level listener below from disarming us before the
    // clear actually runs.
    ev.stopPropagation();
    disarmClear();
    events = [];
    hideDetail();
    refresh({ keepView: false });
  });

  // Any click outside the button, or Escape, cancels a pending confirm.
  // Capture phase so the button's own handler has already run by the time
  // this sees the event.
  document.addEventListener('click', (ev) => {
    if (clearArmed && ev.target !== els.btnClear && !els.btnClear.contains(ev.target)) {
      disarmClear();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') disarmClear();
  });

  els.hintClose.addEventListener('click', () => {
    els.hint.hidden = true;
    try { localStorage.setItem('timeline.hint.dismissed.v2', '1'); } catch {}
  });

  document.querySelectorAll('.seed').forEach((b) => {
    b.addEventListener('click', () => {
      els.search.value = b.dataset.q;
      els.search.dispatchEvent(new Event('input'));
      els.search.focus();
    });
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, textarea')) return;
    if (ev.key === 'f' || ev.key === 'F') { timeline.fit(); }
    else if (ev.key === '>' || ev.key === '.') { timeline.zoomIn(); }
    else if (ev.key === '<' || ev.key === ',') { timeline.zoomOut(); }
    else if (ev.key === 'ArrowLeft') { timeline.scrollBy(-160); }
    else if (ev.key === 'ArrowRight') { timeline.scrollBy(160); }
    else if (ev.key === 'l' || ev.key === 'L') { toggleEventList(); }
    else if (ev.key === 'Escape') {
      // Escape peels back one layer at a time: the results list first,
      // then the event list, then the detail panel, so it never closes
      // more than the thing the user is currently looking at.
      if (!els.results.hidden) { hideResults(); return; }
      if (els.eventList.classList.contains('open')) { setEventListOpen(false); return; }
      hideDetail();
    }
    else if (ev.key === '/' ) { ev.preventDefault(); els.search.focus(); }
  });

  /* ---- boot -------------------------------------------------------- */

  function boot() {
    try {
      if (localStorage.getItem('timeline.hint.dismissed.v2')) els.hint.hidden = true;
    } catch {}

    const fromUrl = Store.fromHash(location.hash);
    events = fromUrl && fromUrl.length ? fromUrl : Store.load();

    // Recompute derived labels in case formatting logic changed since
    // the data was saved.
    events.forEach((e) => {
      e.dateLabel = T.format(e.start, { long: true });
      e.dateLabelShort = e.isSpan && e.end
        ? `${T.format(e.start)} → ${T.format(e.end)}`
        : T.format(e.start);
    });

    window.addEventListener('resize', () => timeline.resize());

    // The overlay sits above the canvas, and tags re-enable pointer-events
    // so they can be clicked. That makes them opaque to the wheel as well:
    // resting the cursor on a label used to kill zoom and pan outright,
    // which is a large fraction of the timeline once labels are packed in.
    // Forward the gesture to the canvas by dispatching the same wheel event
    // there, so the existing dominant-axis routing (vertical = zoom,
    // horizontal = pan, shift/ctrl = forced zoom) runs unchanged and the
    // cursor anchor still refers to the right pixel. Only wheel is
    // forwarded - pointer events must stay on the tag so clicks work.
    els.overlay.addEventListener('wheel', (ev) => {
      if (ev.defaultPrevented) return;
      ev.preventDefault();
      els.canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaX: ev.deltaX,
        deltaY: ev.deltaY,
        deltaMode: ev.deltaMode,
        clientX: ev.clientX,
        clientY: ev.clientY,
        ctrlKey: ev.ctrlKey,
        metaKey: ev.metaKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        bubbles: false,
        cancelable: true,
      }));
    }, { passive: false });

    // The overlay is absolutely positioned over the canvas; if the
    // layout box changes, the canvas must follow.
    if (window.ResizeObserver) {
      new ResizeObserver(() => timeline.resize()).observe(els.viewport);
    }

    // The list starts closed. Remembering it open would surprise the user
    // on a fresh visit with a panel covering the timeline they came for.
    setEventListOpen(false);

    // Sets are offered, never applied. Nothing here touches the timeline
    // until the user clicks a row, so opening the page never replaces a
    // timeline someone was already working on.
    renderSetPicker();

    timeline.resize();
    refresh({ keepView: false });
    if (events.length) timeline.fit();

    // From here on, every change is written through to localStorage.
    persistEnabled = true;
    Store.save(events);

    els.search.focus();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  boot();
})();