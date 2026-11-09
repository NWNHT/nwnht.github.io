/* ------------------------------------------------------------------
 * timeline.js — the renderer.
 *
 * The hard problem: an event list can span 4.5 billion years ("Big
 * Bang", "formation of Earth") or 3 days ("Apollo 11 launch to
 * splashdown"). No single linear scale shows both. So the axis is
 * *piecewise adaptive*: we run the projection through a curve whose
 * compression changes with the local gap size.
 *
 * The approach: each event contributes a weight based on how much space
 * it deserves, and we lay events out along a monotonic axis where the
 * distance between neighbours is a blend of linear time and log time.
 * A `stretch` power parameter controls the blend, and it is chosen
 * automatically from the data so that the smallest meaningful gap is
 * still visible while the total span fits the viewport.
 *
 * Everything is drawn on a canvas for smooth panning at 60fps, with a
 * DOM overlay for labels/links (so tags are real anchors that open
 * Wikipedia in a new tab, and are selectable and accessible).
 * ------------------------------------------------------------------ */

  /**
   * Canvas palette. The canvas cannot read CSS variables directly, so we
   * mirror them here and read the live values off <body> when available.
   * Everything is tuned for the light parchment background.
   */
  const THEME_FALLBACK = {
    grid:    'rgba(90,74,52,0.20)',
    gridInk: 'rgba(90,74,52,0.62)',
    railCap: 'rgba(90,74,52,0.42)',
    bracket: 'rgba(90,74,52,0.34)',
    chipBg:  'rgba(250,243,228,0.94)',
    chipInk: 'rgba(74,58,38,0.92)',
    halo:    'rgba(248,240,224,0.92)',
    hotRing: 'rgba(60,44,26,0.85)',
    // Ruler tick tiers, keyed by the interval the marker stands for:
    // decade (10-year, purple), half-century (green), century (red),
    // quarter-millennium (250-year, blue), millennium (green).
    tick:           'rgba(90,74,52,0.38)',
    tickInk:        'rgba(90,74,52,0.62)',
    tickDecade:     '#7a4f9e',
    tickHalf:       '#5f9e63',
    tickCentury:    '#b23b30',
    tickQuarter:    '#2f7bb5',
    tickMillennium: '#2f6b3c',
    // The BC/AD epoch gets its own ink: the boundary is the one point on
    // the ruler a reader can misread by a year, so it is drawn heavier
    // than any round-number tier rather than borrowing one of their hues.
    tickEpoch:      '#8a4a12',
    tickEpochInk:   '#6d3a0c',
    rulerChip:      'rgba(250,243,228,0.94)',
  };

  function readTheme() {
    const t = { ...THEME_FALLBACK };
    try {
      const cs = getComputedStyle(document.body);
      for (const k of Object.keys(THEME_FALLBACK)) {
        const v = cs.getPropertyValue('--tl-' + k).trim();
        if (v) t[k] = v;
      }
    } catch { /* keep fallbacks */ }
    return t;
  }

  /**
   * How much of the timeline a spanning event must cover before it
   * forces the axis to a fixed linear scale.
   *
   * The rationale is honesty: a bar's length is something the reader
   * measures against the ruler, and a nonlinear axis misreports it. But
   * that only becomes visible when the bar is a meaningful fraction of
   * what is on screen. Wikipedia returns multi-day ranges for events
   * like a Moon landing, and a 55-year span among two millennia is under
   * 3% - at that size the curvature is imperceptible, and locking the
   * axis would needlessly override an explicit user choice. Past roughly
   * a fifth of the visible range the distortion does start to mislead.
   */
  const SPAN_FORCES_LINEAR_SHARE = 0.2;

  /**
   * How much wider than a pixel-exact fit the "Fit" view is. A fit where
   * content width equals viewport width leaves zero scroll range, which
   * makes drag-to-pan feel broken; 12% gives a little travel at each end
   * while still showing every event.
   */
  const FIT_OVERSCAN = 1.12;

  // A lone span has no neighbours to set a scale, so it gets a window of
  // its own: the span should sit across the middle of the display. The
  // window is slightly *narrower* than twice the span because the edge
  // pads and the fit overscan would otherwise shrink the visible bar well
  // below the middle of the viewport.
  const SPAN_SOLO_WINDOW_MULT = 1.15;

  /**
   * How many bar rows stacked mode may spread its bars across, and the
   * vertical pitch between them. The labels have left the bar tracks in
   * this mode, so a row only has to clear a bar (~14px); 26px leaves a
   * comfortable gap without the chart stringing out down the window.
   */
  const STACKED_MAX_ROWS = 6;
  const STACKED_LANE_PITCH = 26;
  // Upper bound on how far the bar pitch may stretch on a tall window.
  // Past this the rows stop reading as one dense block and the stems to
  // the labels get uncomfortably long, so remaining height is simply left
  // as breathing room above the stack instead of being spent on pitch.
  const STACKED_LANE_PITCH_MAX = 56;
  // Upper bound on the vertical pitch between stacked label tracks. A
  // tall window would otherwise spread a handful of labels across the
  // whole canvas, reading as unrelated to the bars they name.
  const STACKED_LABEL_TRACK_MAX = 120;

  const Timeline = (() => {

  const DEFAULTS = {
    // The chart ships with a fixed (linear) axis: one constant
    // year-per-pixel rate everywhere, so distances are directly
    // comparable. 'adaptive' is still implemented - it expands crowded
    // stretches of time - but nothing selects it any more.
    scaleMode: 'linear',
    // Axis weight blend. 1 = pure log (tiny gaps get lots of room),
    // 0 = pure linear (true proportional time). Only consulted in
    // 'adaptive' mode; 'linear' forces 0.
    logWeight: 0.72,
    // Padding at each end of the content, in px.
    edgePad: 90,
    // Minimum px between adjacent event anchors.
    // Minimum horizontal separation between adjacent events. This is
    // what keeps tags from piling on top of one another when two dates
    // are close: it has to be comparable to a tag's width, not a pin's.
    minGapPx: 96,
    // Vertical lane height per track.
    laneH: 74,
    // Where event labels sit relative to their bars:
    //
    //   'inline'  - each label occupies the same track as its bar, so
    //               labels and bars interleave vertically. Compact, but a
    //               label can sit between two bars and break the eye-line.
    //   'stacked' - every label is lifted into label-only tracks above
    //               the bars. All bars then share the baseline and can be
    //               compared directly by length and position.
    labelMode: 'stacked',
    // How many label tracks to reserve in 'stacked' mode before labels
    // start sharing tracks. Labels are narrower than bars, so they pack
    // into fewer tracks than the bars need.
    labelLanes: 0,   // 0 = derive from layout
    // Height of a label-only track, which is shorter than a bar track
    // because it has no glyph underneath.
    labelLaneH: 28,
  };

  function create(opts) {
    const canvas = opts.canvas;
    const overlay = opts.overlay;
    const ctx = canvas.getContext('2d');

    // Canvas colours, read once from CSS custom properties and re-read on
    // demand so a theme change is a `draw()` away.
    let theme = readTheme();
    function refreshTheme() { theme = readTheme(); }

    const state = {
      events: [],          // [{ id, label, color, startY, endY, instant, ... }]
      order: [],           // events sorted by startY
      x: [],               // computed pixel anchor per event (content space)
      width: 0,            // content width in px
      viewX: 0,            // scroll offset in content px
      viewW: 0,            // viewport width
      cssW: 0, cssH: 0,
      scale: 1,
      lanes: 1,
      drag: null,
      hoverId: null,
      focusId: null,
      axis: null,          // computed axis ticks
      opts: Object.assign({}, DEFAULTS, opts || {}),
    };

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

    /* ---- geometry --------------------------------------------------- */

    function resize() {
      const r = canvas.parentElement.getBoundingClientRect();
      state.cssW = Math.max(1, Math.floor(r.width));
      state.cssH = Math.max(1, Math.floor(r.height));
      const d = dpr();
      canvas.width = Math.floor(state.cssW * d);
      canvas.height = Math.floor(state.cssH * d);
      canvas.style.width = state.cssW + 'px';
      canvas.style.height = state.cssH + 'px';
      ctx.setTransform(d, 0, 0, d, 0, 0);
      state.viewW = state.cssW;
      layout();
      draw();
    }

    /**
     * Compute the axis projection.
     *
     * We build an "effective time" coordinate where each unit of raw
     * time is compressed according to the local density of events:
     *
     *   w(i) = (gapToNext_i ^ p)     with p = 1 - logWeight
     *
     * Then we lay out cumulative sums of w, normalised to the content
     * width. Because w is monotonic in the gap and the gaps consume the
     * whole interval, the mapping stays strictly increasing (no events
     * ever swap sides) while small gaps keep a floor of `minGapPx`.
     *
     * The `minGapPx` floor is what guarantees the smallest gap stays
     * legible; `width` guarantees the whole thing fits in the viewport
     * when zoomed to fit. Both cannot hold at once for extreme data, so
     * when they conflict we prefer the floor and let the user scroll —
     * which is exactly what the horizontal scrolling is for.
     */
    function layout() {
      const evs = state.events.slice();

      if (!evs.length) {
        state.order = [];
        state.x = [];
        state.width = state.viewW;
        state.axis = null;
        state.soloWindow = null;
        return;
      }

      // Sort by start instant (falls back to end for pure span events).
      evs.sort((a, b) => a.startY - b.startY || a.endY - b.endY);
      state.order = evs;

      const n = evs.length;
      const ys = evs.map((e) => e.startY);

      // A lone event gives the axis no extent of its own, so the layout
      // would squeeze the whole chart into that one instant: the ruler
      // showed a single tick and the rest of the window was empty, with
      // no sense of what decade the event sat in. Both single-event cases
      // are therefore given an explicit window instead.
      //
      //   point event - a 100-year window centred on it
      //   span        - the span fills the middle half of the display
      //
      // The window is expressed in years and projected linearly below, so
      // the normal tick, pan and zoom machinery all keeps working. The
      // scale is forced to a fit so the window is what you actually see,
      // regardless of how the zoom happened to be left from a previous
      // timeline.
      let soloWindow = null;
      if (n === 1) {
        const e = evs[0];
        // Only re-fit when the solo event itself changed (a different
        // event, or the first time this one was laid out). Otherwise the
        // user's own zoom would be undone on every redraw.
        const sig = e.id + ':' + e.startY + ':' + e.endY;
        if (state.soloSig !== sig) {
          state.soloSig = sig;
          state.scale = FIT_OVERSCAN;
        }
        if (e.isSpan && e.endY > e.startY) {
          const dur = e.endY - e.startY;
          // Put the span across the middle half of the display. The
          // window is symmetric about the span's centre, so the bar stays
          // centred wherever the viewport is scrolled.
          const mid = (e.startY + e.endY) / 2;
          const halfWin = dur * SPAN_SOLO_WINDOW_MULT;
          soloWindow = { lo: mid - halfWin, hi: mid + halfWin };
        } else {
          soloWindow = { lo: e.startY - 50, hi: e.startY + 50 };
        }
      } else {
        state.soloSig = null;
      }

      // Opening the distance between two far-apart points is only worth
      // doing while every event is an instant: then the axis is just a
      // ruler for gaps, and a log blend makes a 4.5 Gyr span and a 3-day
      // span coexist. As soon as one event has *duration*, its bar is a
      // length the user will measure against the ruler — and a nonlinear
      // axis silently lies about it (WWII's 6 years rendering 10x its
      // share). So a dataset containing a *significant* span switches the
      // axis to linear, and zoom + scrolling does the work instead.
      //
      // "Significant" matters: Wikipedia hands us multi-day ranges for
      // things like a Moon landing, and those are point-like next to a
      // 2000-year timeline. Locking the axis to linear for a 1-day bar
      // among millennia would be absurd, so a span only counts when it
      // occupies a noticeable share of the total time on screen.
      const firstY = ys[0], lastY = ys[ys.length - 1];
      const totalYears = Math.max(1e-9, lastY - firstY);
      const hasSpan = evs.some((e) =>
        e.isSpan && e.endY > e.startY && (e.endY - e.startY) / totalYears >= SPAN_FORCES_LINEAR_SHARE
      );

      // Two scale modes, picked by the user in the status bar:
      //
      //   'adaptive' - blend linear time with a log-compressed spacing so
      //                crowded stretches expand and empty ones collapse.
      //                Great for reading clusters, but the year-per-pixel
      //                rate varies along the axis.
      //   'linear'   - one constant year-per-pixel rate everywhere, so
      //                visual distance is directly comparable.
      //
      // A span always forces linear regardless of the mode: a bar's length
      // is a quantity the user measures against the ruler, and a nonlinear
      // axis silently lies about it (WWII's 6 years rendering 10x its
      // share). Zoom + scrolling does the work instead.
      const mode = state.opts.scaleMode === 'linear' || hasSpan ? 'linear' : 'adaptive';
      const logWeight = mode === 'linear' ? 0 : state.opts.logWeight;
      const p = Math.max(0, Math.min(1, 1 - logWeight));
      state.effectiveLogWeight = logWeight;
      state.effectiveMode = mode;
      state.modeForcedBySpan = hasSpan && state.opts.scaleMode !== 'linear';

      // Gap between consecutive anchors (in years), with a small epsilon
      // so coincident events still get a floor rather than 0^p = 0.
      const gaps = [];
      for (let i = 1; i < n; i++) {
        gaps.push(Math.max(1e-9, ys[i] - ys[i - 1]));
      }

      // Build weights. gap^p maps a 3-order-of-magnitude spread down to
      // about one order, which is what lets a 4.5 Gyr span and a 3-day
      // span coexist. We normalise against the geometric centre so the
      // shape is scale-invariant.
      const sum = gaps.reduce((a, g) => a + Math.pow(g, p), 0);

      // Content layout.
      //
      // Events are placed inside [edgePad, width - edgePad], so the pad on
      // each side is what lets you pan past the ends. `state.scale` is
      // the master zoom: at scale 1 the timeline exactly fills the
      // viewport (events plus their pads), so a fresh timeline is
      // fit-to-width yet still pannable if we widen the pad band.
      const viewW = state.viewW;
      const pad = state.opts.edgePad;

      // The band the events themselves occupy at scale 1.
      const fitBand = Math.max(1, viewW - pad * 2);

      // Minimum band: enough for the per-gap floor and the extra pad.
      const floorBand = Math.max(
        fitBand,
        (n - 1) * state.opts.minGapPx + 120
      );

      // Band scales linearly with zoom.
      const band = Math.max(fitBand, floorBand) * state.scale;

      // Total scrollable content: the band plus a pad on each side, and
      // at least a viewport wide so the scroll ranges are sane.
      let width = Math.max(viewW, band + pad * 2);

      const usable = band;

      // Cumulative positions in "effective" units.
      const x = new Array(n);
      x[0] = 0;
      for (let i = 1; i < n; i++) {
        const w = sum > 0 ? Math.pow(gaps[i - 1], p) / sum : 1 / (n - 1);
        x[i] = x[i - 1] + w;
      }
      // Normalise 0..1 -> content px
      const span = x[n - 1] || 1;
      for (let i = 0; i < n; i++) {
        x[i] = state.opts.edgePad + (x[i] / span) * usable;
      }

      // Enforce a hard minimum pixel separation. The log blend usually
      // handles this, but many events sharing one date (or a coarse
      // 1-year precision next to an exact date) can still collide.
      //
      // In 'linear' mode the floor is capped so it can never dominate the
      // axis: the whole point of linear mode is that one year is always
      // the same number of pixels, and a floor that widens the 10-year
      // gaps of a 2900-year timeline would compress the big gap instead
      // and destroy exactly the property the user asked for. There we
      // only lift truly coincident events apart.
      if (n > 1) {
        // In 'linear' mode there is deliberately no legibility floor. A
        // dataset with a 2900-year gap and 10-year gaps cannot show both
        // at one constant rate in a viewport; the honest rendering is to
        // let the short gaps be nearly coincident and rely on zoom to
        // separate them.
        if (state.effectiveMode !== 'linear') {
          const minGap = Math.min(state.opts.minGapPx, usable / Math.max(1, n - 1));
          for (let i = 1; i < n; i++) {
            if (x[i] - x[i - 1] < minGap) x[i] = x[i - 1] + minGap;
          }

          // Rescale so the run exactly fills the band again. The floor has
          // already guaranteed relative legibility; this keeps the extent
          // honest and preserves monotonicity and proportions.
          const runStart = x[0];
          const runLen = x[n - 1] - runStart;
          if (runLen > 0 && Math.abs(runLen - usable) > 0.5) {
            const k = usable / runLen;
            for (let i = 0; i < n; i++) x[i] = pad + (x[i] - runStart) * k;
          }
        }
      } else if (n === 1) {
        // A lone event sits at the centre of its chosen window. When the
        // event is a span, the window was built so the bar fills the
        // middle half of the display; the centre of the band is the
        // centre of that span either way.
        x[0] = pad + usable / 2;
      }

      state.x = x;
      state.width = width;

      // Attach pixel anchors to each event. x0 is the start; x1 the end
      // of a span. A span end is projected through the same piecewise
      // mapping, so a span crossing a compressed region looks right.
      const allYs = ys;
      // A lone span is projected against its own window rather than the
      // single-point event series, which has no slope and would collapse
      // the bar to zero width.
      const spanProj = soloWindow
        ? (y) => {
            const t = (y - soloWindow.lo) / Math.max(1e-9, soloWindow.hi - soloWindow.lo);
            return state.opts.edgePad +
              t * (width - state.opts.edgePad * 2);
          }
        : null;
      for (let i = 0; i < n; i++) {
        const e = evs[i];
        e.x0 = x[i];
        if (e.isSpan && e.endY > e.startY) {
          e.x1 = spanProj ? spanProj(e.endY) : projectY(e.endY, evs, x, allYs);
          if (e.x1 < e.x0) e.x1 = e.x0;
          // A span whose end lies beyond the last event is extrapolated
          // and can shoot thousands of px wide (the Cold War ending in
          // 1991 when the last event is 1944). Clamp to the content box
          // and flag it, so the renderer can draw an explicit "continues"
          // chevron rather than an absurdly long bar.
          //
          // A lone span is exempt: its end is always past the single
          // event's start, but it is not running off the timeline - it is
          // the whole timeline, and its window was sized around it.
          if (!spanProj && e.endY > ys[n - 1]) {
            e.openEnd = true;
            e.x1 = Math.min(e.x1, width - state.opts.edgePad * 0.4);
          }
          // A span narrower than this is hard to see and impossible to
          // click. Floor it so the duration is still discoverable, and
          // mark it so the renderer can hint that it is compressed
          // relative to the axis.
          const MIN_SPAN_PX = 8;
          if (e.x1 - e.x0 < MIN_SPAN_PX) {
            e.x1 = e.x0 + MIN_SPAN_PX;
            e.compressed = true;
          }
        } else {
          e.x1 = x[i];
        }
      }

      // Anchors must be non-decreasing. Note that we only ever push an
      // event *right* if its own start is behind the previous *start*;
      // we must NOT compare against the previous event's span end, or a
      // long bar (WWII, 1939-1945) shoves every later event to its right
      // edge and they collapse into a pile.
      for (let i = 1; i < n; i++) {
        if (evs[i].x0 < evs[i - 1].x0) evs[i].x0 = evs[i - 1].x0;
        if (evs[i].x1 < evs[i].x0) evs[i].x1 = evs[i].x0;
      }

      // Events are anchored at their start; spans extend rightwards using
      // the same projection (so a span crossing a compressed region looks
      // proportionally right).
      // A solo window replaces the event-derived extent for axis purposes.
      // `state.soloWindow` is read by computeAxis and by the year<->pixel
      // projection, so the ruler, the ticks and panning all behave exactly
      // as they would for a real two-event timeline spanning that range.
      state.soloWindow = soloWindow;
      state.axis = computeAxis(evs, x, ys);
    }

    /* ---- axis ticks -------------------------------------------------
     * Choose tick steps that are "round" numbers in the current unit
     * (years, centuries, millennia, Myr...) so the labels read like a
     * real ruler rather than arbitrary decimals.
     */
    // Tick steps, in years, in preference order within each magnitude.
    // A 1-2.5-5 progression reads as "round" numbers to a human: 25, 50,
    // 100, 250, 500, 1000, 2500, ... rather than the 20/200/2000 that a
    // 1-2-5 series produces and that never quite looks like a calendar.
    const TICK_STEPS = [
      // Sub-year steps, for timelines measured in days or weeks (a Moon
      // mission, a war's final week). Expressed in years.
      1 / 365.2422, 2 / 365.2422, 7 / 365.2422, 14 / 365.2422,
      1 / 12, 1 / 4, 1 / 2,
      // Years, 1-2.5-5 by decade and century.
      1, 2, 5, 10, 25, 50, 100, 250, 500,
      1000, 2500, 5000, 10000, 25000, 50000, 100000,
      250000, 500000, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7,
      1e8, 2.5e8, 5e8, 1e9, 2.5e9, 5e9,
    ];

    /**
     * Pick the step from the ladder that best matches the ideal spacing.
     * Preference is by *ratio*, so a target of 30 years lands on 25 (closer
     * proportionally than 50), and ties go to the smaller, tidier step.
     */
    function nearestStep(raw) {
      const target = Math.max(1e-6, Math.abs(raw));
      let best = TICK_STEPS[0], bestScore = Infinity;
      for (const s of TICK_STEPS) {
        const score = Math.abs(Math.log(s / target));
        if (score < bestScore - 1e-9) { best = s; bestScore = score; }
      }
      return best;
    }

    function computeAxis(evs, x, ys) {
      // A lone event has no extent of its own, so the axis is built from
      // the window layout() chose for it instead. `first`/`last` below are
      // the window's ends, which makes an ordinary linear ruler.
      const solo = state.soloWindow;
      const first = solo ? solo.lo : ys[0];
      const last = solo ? solo.hi : ys[ys.length - 1];
      // The pixel mapping must use the same ends, so the synthetic
      // two-point series is used for projection while the real event list
      // continues to drive the events themselves.
      const axYs = solo ? [solo.lo, solo.hi] : ys;
      const axX = solo ? [state.opts.edgePad, state.width - state.opts.edgePad] : x;
      const totalSpan = last - first;
      // Target ~9 ticks across the content width.
      const targetPx = 130;
      const nTicks = Math.max(2, Math.round(state.width / targetPx));

      // Every event on the same date (or a lone event) gives a zero span,
      // so "span / nTicks" is 0 and the nearest step would be a fraction
      // of a day - a ruler of microseconds, labelled with raw floats like
      // 1919.0005974117994. Instead pick a step from the magnitude of the
      // date itself, so a lone 1919 gets 25-year ticks.
      const step = totalSpan > 1e-9
        ? nearestStep(totalSpan / nTicks)
        : nearestStep(Math.max(1e-9, Math.abs(first) / 40) || 1);

      // Build the tick grid.
      //
      // The grid must be anchored in *display* year numbers, not the
      // astronomical ones used internally, and the two eras have
      // different origins:
      //
      //   AD  : display year = astronomical year
      //   BC  : display year = 1 - astronomical year
      //
      // So a single global origin cannot serve both. Offsetting by 1 to
      // fix BC (which turns -100, -200 into 100 BC, 200 BC) leaves the AD
      // side broken, emitting 251 AD and 751 AD instead of 250 and 750.
      // We therefore generate the two eras as separate series, each
      // snapped to round *display* years, and merge them.
      const ticks = [];
      const maxTicks = 400; // safety, per era

      // AD/CE series: astronomical year a is display year a. Year 0 is
      // 1 BC, so this series starts at astronomical 0.
      const adStart = Math.floor(Math.max(0, first) / step) * step;
      for (let i = 0; i < maxTicks; i++) {
        const v = adStart + i * step;
        if (v > last + step * 0.5) break;
        if (v < first - step * 0.5) continue;
        if (v < 0) continue;                 // belongs to the BC series
        ticks.push({ y: v, x: projectY(v, evs, axX, axYs), era: 'AD' });
      }

      // BC/BCE series: astronomical -99 is 100 BC, so display 100 BC is
      // astronomic -99 and the grid steps by `step` in display years.
      if (first <= 0) {
        const bcFirstDisplay = 1 - first;      // largest display year
        const bcStartDisplay = Math.floor(bcFirstDisplay / step) * step;
        const bcTicks = [];
        for (let i = 0; i < maxTicks; i++) {
          const disp = bcStartDisplay - i * step;   // count downwards
          if (disp < 1) break;
          const v = 1 - disp;                      // -> astronomical
          if (v > last + step * 0.5) continue;
          if (v < first - step * 0.5) continue;
          bcTicks.push({ y: v, x: projectY(v, evs, axX, axYs), era: 'BC' });
        }
        ticks.unshift(...bcTicks.reverse());
      }

      // Keep the merged ruler in time order.
      ticks.sort((a, b) => a.y - b.y);

      // Grade each tick into a minor/major tier. The grade is taken from
      // the tick's *display* year, so 2000 BC and AD 2000 both count as
      // round, and it is expressed as a multiple of the current step: a
      // tick that lands on a 5x or 10x step is a decade/century landmark
      // relative to its neighbours rather than just another division.
      assignTickTiers(ticks, step);

      // Never show a bare "no ruler" axis when a span is shorter than one
      // step: fall back to marking the two endpoints.
      if (ticks.length < 2 && ys.length) {
        ticks.length = 0;
        ticks.push({ y: first, x: x[0], era: 'BC', tier: 1, tierStep: step });
        if (last > first) ticks.push({ y: last, x: x[ys.length - 1], era: 'AD', tier: 1, tierStep: step });
      }
      return { ticks, step, first, last, subYear: step < 1 };
    }

    /**
     * Label every tick with a tier: 0 = minor, 1 = major, 2 = landmark.
     *
     * The ruler uses one uniform step, so "major" can only mean "rounder
     * than its neighbours", which we get by asking how many whole steps
     * the tick sits from the era's origin in *display* years. A tick 10
     * steps from the origin is a rounder number than one 1 step away, and
     * that is what earns it a longer stroke and a stronger colour.
     *
     * Grading on the display year is what keeps BC and AD symmetric:
     * astronomic -99 is 100 BC, so it must be allowed to be a landmark
     * even though -99 is not a round astronomic number.
     */
    function assignTickTiers(ticks, step) {
      // A tick is "major" when it sits at a round distance from the era
      // origin - measured in steps, so the grade is independent of what
      // the current step happens to be. Two steps from the origin is a
      // minor division; ten steps is a decade landmark; a hundred steps
      // is the big one. Only one tier should dominate, so the grades are
      // chosen so that most ticks stay minor.
      // The classic round intervals a marker can stand for, largest
      // first. The first one that divides the tick's display year evenly
      // is the interval this marker represents, and it is what determines
      // the colour: 10-year purple, 50-year green, century red,
      // millennium green.
      const ROUND_STEPS = [
        1e9, 1e8, 5e7, 1e7, 5e6, 1e6, 5e5, 1e5, 5e4, 25000, 10000,
        5000, 2500, 2000, 1000, 750, 500, 250, 200, 100, 50, 25, 20, 10, 5,
      ];

      for (const t of ticks) {
        // Display year: negative for BC, positive for AD. Signed so the
        // rounding lattice runs continuously through the epoch.
        const disp = t.era === 'BC' ? -Math.round(1 - t.y) : Math.round(t.y);
        const mag = Math.abs(disp);

        // Which round interval does this year sit on? 1600 is a century
        // (and also a millennium, but we take the largest that applies
        // and cap it, or every century would look like a millennium).
        let interval = 0;
        for (const r of ROUND_STEPS) {
          if (r <= mag && mag % r === 0) { interval = r; break; }
        }

        // Tier drives stroke prominence only; colour comes from the
        // interval. Every 10th step is a landmark, every 5th a major
        // division, the rest minor.
        const nSteps = step > 0 ? Math.round(mag / step) : 0;
        let tier = 0;
        if (mag === 0) tier = 2;
        else if (nSteps % 10 === 0) tier = 2;
        else if (nSteps % 5 === 0) tier = 1;

        t.tier = tier;
        t.tierStep = interval || step;   // the round interval it marks
        t.displayYear = disp;
        // The epoch pair: astronomical year 0 renders as "1 BC" and
        // astronomical year 1 as "1 AD". Detect them from the astronomical
        // year, not the display year, so the test cannot drift: disp=-1 is
        // 2 BC (an ordinary stop) while disp=0 is 1 BC (the epoch).
        t.epoch = (t.y === 0 || t.y === 1);
      }
    }

    /**
     * Map an arbitrary year to a content-pixel x, by interpolating
     * inside the bracketing pair of laid-out events. Outside the event
     * range we extrapolate using the nearest gap's local scale so the
     * ruler stays visually consistent past the ends.
     */
    function projectY(y, evs, x, ys) {
      const n = ys.length;
      if (n === 1) return state.opts.edgePad + (state.width - state.opts.edgePad * 2) / 2;
      if (y <= ys[0]) {
        if (n < 2) return x[0];
        const dy = ys[1] - ys[0] || 1;
        const per = (x[1] - x[0]) / dy;
        return x[0] + (y - ys[0]) * per;
      }
      if (y >= ys[n - 1]) {
        const dy = ys[n - 1] - ys[n - 2] || 1;
        const per = (x[n - 1] - x[n - 2]) / dy;
        return x[n - 1] + (y - ys[n - 1]) * per;
      }
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ys[mid] <= y) lo = mid; else hi = mid;
      }
      const dy = ys[hi] - ys[lo] || 1;
      const t = (y - ys[lo]) / dy;
      return x[lo] + t * (x[hi] - x[lo]);
    }

    const yearToX = (y) => projectY(y, state.order, state.x, state.order.map((e) => e.startY));

    // Height of a span's bar, in px. Shared by the renderer and the
    // overlay so a span's tag always clears its own bar.
    const SPAN_BAR_H = 12;

    /* ---- lanes ------------------------------------------------------
     * Events get vertical lanes so their *tags* do not overlap. Tags are
     * DOM elements about TAG_W wide and are anchored above the point, so
     * reserving only the pin's own width is not enough: two events a few
     * pixels apart would still stack their labels on top of each other.
     *
     * Greedy interval colouring over [xStart, xEnd + tagWidth].
     */
    const TAG_W = 160;   // approx rendered tag width incl. padding
    const TAG_GAP = 18;  // minimum breathing room between tags

    // Real label widths, filled in by the DOM after each render. Packing
    // a label needs its width before the element exists, so the first
    // layout uses TAG_W; the measured widths are fed back for every
    // layout after that. Keyed by event id: a label's rendered width is a
    // function of its text and the stylesheet font, so a stored width
    // stays valid for as long as the event does.
    const labelW = new Map();
    // Set by syncOverlay when a measured label width changed, consumed by
    // draw() to run one extra layout pass with the true widths.
    let measuredChanged = false;

    function labelWidthOf(e) {
      return labelW.get(e.id) || TAG_W;
    }

    function assignLanes() {
      const hv = state.opts;
      const stacked = hv.labelMode === 'stacked';

      /**
       * Assign bar rows for stacked mode by colouring the interval graph.
       *
       * Two events conflict only when their bars strictly overlap, so
       * intervals that merely touch — the contiguous run Kingdom ->
       * Republic -> Empire -> Byzantine — do not conflict and can share a
       * row. Colouring greedily by start position then guarantees the
       * smallest possible number of rows for the overlaps that are really
       * there, and keeps each touching run on a single baseline.
       *
       * When more rows are available than the colouring needs, the rows
       * are spread out from the top so the bars use the height instead of
       * huddling, while row 0 stays reserved for the events that fit
       * there, preserving the shared-baseline comparison.
       */
      function assignStackedRows(rows) {
        const byStart = state.order.slice().sort(
          (a, b) => (a.x0 - b.x0) || (a.x1 - b.x1)
        );
        // rowEnd[r] = content-x at which row r becomes free again.
        const used = [];
        const colour = new Map();
        for (const e of byStart) {
          let r = 0;
          // A row is free when its last bar ends at or before this bar
          // starts. Using <= keeps touching bars (x1 === x0) together.
          while (r < used.length && used[r] > e.x0) r++;
          if (r >= used.length) used.push(-Infinity);
          used[r] = e.x1;
          colour.set(e, r);
        }
        const depth = Math.max(1, used.length);
        // Spread only if there is spare room. `depth` rows are essential;
        // beyond that we may fan the deeper colours out over the rest.
        for (const e of state.order) {
          const c = colour.get(e) || 0;
          e.lane = c < depth ? Math.min(c, rows - 1) : (c % rows);
        }
      }

      /**
       * The height the stacked label band is about to occupy. assignLanes
       * runs before layout() has measured it, so it is estimated from the
       * label track count, which pass 2 fixes below from the same packing
       * rule. Only used to keep the bar rows from crowding the labels.
       */
      function labelZoneFor() {
        if (state.opts.labelMode !== 'stacked') return 0;
        const tracks = state.labelLanes || 1;
        return tracks * Math.max(26, state.opts.labelLaneH) + 10;
      }

      // Pass 1: vertical tracks for the bars and pins themselves. These
      // are what the ruler measures against, so in 'stacked' mode they
      // all end up on the same baseline whenever it fits.
      //
      // Rows are assigned by collision group rather than by greedy
      // packing in x-order. Greedy packing lets a later, unrelated event
      // steal the row a contiguous run is using, which splits that run
      // across rows and destroys the shared baseline stacked mode exists
      // to provide. Grouping instead keeps a chain of touching spans
      // (Kingdom -> Republic -> Empire) together on one row.
      const maxLanes = stacked
        ? Math.max(1, Math.min(STACKED_MAX_ROWS,
            Math.floor((state.cssH - 200 - labelZoneFor()) / STACKED_LANE_PITCH)))
        : Math.max(1, Math.floor((state.cssH - 140) / hv.laneH));
      const lanes = [];
      for (const e of state.order) {
        const a = contentToScreen(e.x0);
        const b = contentToScreen(e.x1);
        // A tag is wider than a pin, and a span's bar is wider than both.
        // Reserve whichever is greater so labels never collide.
        const spanW = Math.max(b - a, 0);
        // In stacked mode labels live elsewhere, so a bar only needs to
        // clear other bars - it need not reserve a tag's width. Crucially
        // that means a bar may reuse any lane whose previous occupant has
        // already finished, which is what collapses a run of consecutive
        // spans (Kingdom -> Republic -> Empire -> Byzantine) onto one
        // baseline so their lengths can be compared directly. A small
        // pad keeps neighbouring glyphs from visually touching.
        const reserve = stacked ? 0 : Math.max(TAG_W, spanW) + TAG_GAP;
        // A bar may share a lane as soon as the previous occupant has
        // finished drawing. Contiguous spans meet exactly (x1 === x0) and
        // genuinely do not overlap, so in stacked mode the only reason to
        // take a new row is a strict overlap.
        const threshold = stacked ? a : a - reserve;
        let lane = 0;
        while (lane < lanes.length && lanes[lane] > threshold) lane++;
        if (lane >= lanes.length) lanes.push(-Infinity);
        lanes[lane] = Math.max(b, a) + reserve;
        e.lane = Math.min(lane, maxLanes - 1);
      }

      // In stacked mode the labels have left the bar tracks, so the bars
      // may be spread over the full row budget instead of only the rows
      // greedy packing happened to need. Inline mode needs the same
      // headroom for a different reason: its labels now pack in their own
      // pass, and a dense cluster of tags can need more tracks than the
      // bars do, so the label pass is allowed to use the whole budget
      // rather than being pinned to the bar rows.
      const needed = Math.max(1, Math.min(lanes.length, maxLanes));
      const rows = stacked ? maxLanes : needed;
      state.lanes = rows;
      state.inlineLabelCeiling = maxLanes;

      // Greedy packing can scatter a contiguous run, because an event that
      // merely overlaps one member of the run can take the row the next
      // member wanted. Re-derive the rows from the collision groups
      // instead: two events conflict only if their bars truly overlap
      // (strictly, so touching bars are fine). A run of touching spans
      // therefore forms one group and lands on one baseline, which is
      // exactly the comparison stacked mode is for.
      if (stacked && rows > 1) {
        assignStackedRows(rows);
      }

      // Pass 2: vertical tracks for the labels.
      //
      // In stacked mode the labels sit clear of the bars, so a label track
      // can be much shorter than a bar lane. In inline mode the labels
      // ride beside their own glyph, and until now they simply inherited
      // the bar lane (`labelLane = lane`) with no packing of their own.
      // That is fine for a sparse timeline, but a dense cluster of short
      // spans all lands in one lane and the tags pile up on top of each
      // other. So inline mode packs its labels too, using the same
      // measured-width interval test.
      const labelTrackH = Math.max(26, hv.labelLaneH);
      const maxLabelLanes = Math.max(1, Math.floor((state.cssH - 140) / labelTrackH));
      // Each track remembers the x-intervals already claimed on it. A tag
      // that flips near the right edge grows leftwards from its anchor
      // instead of rightwards, so a single "free from here" cursor is not
      // enough: a flipped tag can reach back over a label that was packed
      // earlier on the same track. Testing real intervals handles both
      // orientations.
      const lLanes = [];
      for (const e of state.order) {
        const a = contentToScreen(e.x0);
        const b = contentToScreen(e.x1);
        // Reserve the label's true width, which the DOM measured on the
        // previous pass. `TAG_W` is only an estimate and the stylesheet
        // allows labels up to 210px, so a constant reserve let wide
        // labels overlap the label packed after them.
        const w = labelWidthOf(e);
        // A label flips to the left of its anchor when it would otherwise
        // run past the right edge of the viewport. This mirrors the flip
        // test used when the tag is positioned.
        const flip = a + w > state.cssW - 8;
        const lo = flip ? a - w : a;
        const hi = flip ? a : a + w;
        // Which packed track this label lands on.
        //
        // Stacked labels live in their own band clear of the bars, so
        // they may use the whole band and the first free track is right.
        //
        // Inline labels ride beside their own glyph, so spreading them
        // over their own tracks turns the chart into a tall staircase of
        // boxes far from the bars they name. They therefore start on
        // their own bar row and climb only when that row is genuinely
        // taken, one track at a time, stopping as soon as they clear.
        let lane = 0;
        if (stacked) {
          while (lane < lLanes.length &&
                 lLanes[lane].some((iv) => lo < iv[1] + TAG_GAP && hi + TAG_GAP > iv[0])) {
            lane++;
          }
          if (lane >= lLanes.length) lLanes.push([]);
          lLanes[lane].push([lo, hi]);
          e.labelLane = Math.min(lane, maxLabelLanes - 1);
          e.labelClamped = lane >= maxLabelLanes;
        } else {
          lane = Math.max(0, e.lane || 0);
          let climbed = 0;
          // A label starts on its own bar row and climbs only to dodge a
          // neighbour, one track at a time, stopping at the first free
          // track. It is capped so a dense cluster cannot march labels up
          // past the top of the chart; a clash that survives the cap is
          // recorded in `labelClamped` rather than silently drawn over a
          // neighbour.
          const maxClimb = Math.max(1, state.inlineLabelCeiling || state.lanes || 1);
          const clashes = (r) =>
            (lLanes[r] || []).some(
              (iv) => lo < iv[1] + TAG_GAP && hi + TAG_GAP > iv[0]
            );
          while (clashes(lane) && climbed < maxClimb && climbed < 24) {
            lane++;
            climbed++;
          }
          if (lane >= lLanes.length) lLanes.push([]);
          lLanes[lane].push([lo, hi]);
          e.labelLane = lane;
          e.labelClamped = climbed >= 24 || climbed >= maxClimb;
        }
      }
      state.labelLanes = Math.max(1, Math.min(lLanes.length, maxLabelLanes));
    }

    /* ---- coordinate helpers ----------------------------------------- */

    function contentToScreen(x) { return x - state.viewX; }
    function screenToContent(x) { return x + state.viewX; }

    /**
     * The (years, pixels) series the axis is drawn against.
     *
     * Normally this is the events themselves. A lone event has no extent
     * of its own, so its axis comes from the window layout() picked for
     * it instead - the same substitution computeAxis makes. Both
     * projections below must agree with the tick grid, so they share this
     * one accessor rather than each rebuilding the series.
     */
    function axisSeries() {
      const solo = state.soloWindow;
      if (solo) {
        return {
          ys: [solo.lo, solo.hi],
          xs: [state.opts.edgePad, state.width - state.opts.edgePad],
        };
      }
      const evs = state.order;
      return { ys: evs.map((e) => e.startY), xs: state.x };
    }

    /**
     * Content-x for a year, using the same projection the renderer uses
     * (linear inside the event range, extrapolated past either end).
     */
    function contentXOfYear(y) {
      if (!state.order.length) return null;
      const s = axisSeries();
      return projectY(y, state.order, s.xs, s.ys);
    }

    /**
     * Inverse of `contentXOfYear`: which year sits at a *viewport* x.
     * Binary-searched because the projection is monotonic in y but not
     * analytically invertible (it is a log blend with an extrapolated
     * tail).
     */
    function yearAtScreen(px) {
      if (!state.order.length) return null;
      const target = screenToContent(px);
      const s = axisSeries();
      const ys = s.ys, xs = s.xs;
      const lo0 = Math.min(ys[0], ys[ys.length - 1]);
      const hi0 = Math.max(ys[0], ys[ys.length - 1]);

      // Widen the bracket to cover the extrapolated region past the
      // first/last event, so a cursor outside the event range still maps.
      const pad = Math.max(1, (hi0 - lo0) || 1);
      let lo = lo0 - pad * 2;
      let hi = hi0 + pad * 2;
      if (ys[0] > ys[ys.length - 1]) { const t = lo; lo = hi; hi = t; }

      const at = (y) => projectY(y, state.order, xs, ys);
      const forward = at(ys[0]) <= at(ys[ys.length - 1]);

      // 60 bisections on a float interval is far below one ULP of a year
      // for any practical scale.
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const x = at(mid);
        const before = forward ? x < target : x > target;
        if (before) { if (forward) lo = mid; else hi = mid; }
        else { if (forward) hi = mid; else lo = mid; }
      }
      return (lo + hi) / 2;
    }

    function clampView() {
      const maxX = Math.max(0, state.width - state.viewW);
      // Allow scrolling until the outermost events can reach the centre
      // of the screen. Events live inside [edgePad, width - edgePad], so
      // centring the first one means viewX = edgePad - viewW/2, and
      // centring the last means viewX = (width - edgePad) - viewW/2.
      // Clamping to the plain [0, maxX] range instead would pin the
      // first and last events to the edge, where their labels collide
      // with the ruler and can't be read against their own position.
      const pad = state.opts.edgePad;
      const firstX = pad;
      const lastX = state.width - pad;
      const minX = Math.min(firstX - state.viewW / 2, maxX);
      const maxViewX = Math.max(lastX - state.viewW / 2, 0);
      // If the whole range already fits, fall back to the plain bounds so
      // a single-event timeline doesn't drift off into empty space.
      const lo = Math.min(minX, maxX);
      const hi = Math.max(maxViewX, 0);
      state.viewX = Math.max(lo, Math.min(state.viewX, hi));
    }

    /* ---- drawing ---------------------------------------------------- */

    function draw() {
      const { cssW: W, cssH: H } = state;
      ctx.clearRect(0, 0, W, H);

      if (!state.order.length) { syncOverlay(); return; }

      // Lanes first: the rail height depends on how many lanes we need.
      // (assignLanes uses the screen positions from the last layout, so
      // it is stable frame to frame.)
      assignLanes();

      measuredChanged = false;

      // Vertical budget: lanes + tags above the rail, then the gap band
      // and the axis band below it. Keep the rail low enough to leave
      // lane room but high enough that both bottom bands fit.
      //
      // The band must clear the deepest thing the ruler draws: ticks start
      // at railY + 52, a millennium stop runs 18px, and its label sits 2px
      // below that in an 11px face - about 83px. The epoch label is the
      // worst case at roughly 87px, since it uses a larger bold face below
      // a full-height rule. 74px let the tick labels run into the status
      // bar underneath, so the budget is sized from that worst case with a
      // few pixels of breathing room.
      const bottomBands = 96;                        // gap bracket + tick labels
      // In stacked mode the labels need their own room above the bars, on
      // top of whatever the bar tracks already take. Each track only needs
      // to clear the tag box itself; the stems bridge the rest, so there
      // is no reason to leave a wide dead band under the label block.
      const stacked = state.opts.labelMode === 'stacked';
      const labelTrackH0 = Math.max(26, state.opts.labelLaneH);
      // How many bar rows actually hold a glyph. The row budget may be
      // larger (stacked mode reserves up to STACKED_MAX_ROWS so rows are
      // available when overlaps need them), but empty rows must not take
      // vertical space: doing so lifted the label band clear of the bars
      // and left a long, empty strip crossed by very tall stems.
      const usedRows = stacked
        ? Math.max(1, ...state.order.map((e) => (e.lane || 0) + 1))
        : Math.max(1, state.lanes);
      // 74px per lane is the tag pitch used when a label rides beside its
      // own bar. In stacked mode the labels have moved out of the bar
      // tracks entirely, so the bars only need enough room to stay
      // visually separate: a lane pitch of 74 there left the bars floating
      // a long way below their labels.
      //
      // The rail is placed against the bottom of the viewport so the chart
      // fills the window. `bottomBands` is always reserved underneath it,
      // which keeps the gap brackets and tick labels on screen. Anything
      // left between the label band and the rail is bar room, and the
      // pitch is derived from it below — so a tall window gets taller bar
      // rows rather than a taller empty band.
      const topMargin = 18;
      const railY = Math.round(Math.max(
        topMargin + 150,                       // keep the stack legible
        H - bottomBands - 6                    // keep the tick band visible
      ));
      state.absRailY = railY;

      // Split the space between the top of the chart and the rail into a
      // bar block and a label block.
      //
      // The old layout gave the bars everything and put the labels on a
      // fixed 28px pitch just above them. That is why a tall window showed
      // hundreds of empty pixels while labels overlapped: the band never
      // grew, so there was nowhere for a crowded label to escape to. Here
      // the two blocks are sized together, and each label track ends up as
      // tall as the room allows.
      const lanes = Math.max(1, state.labelLanes || 1);
      const roomForStack = Math.max(
        150,
        railY - topMargin - 6
      );
      // Reserve a minimum for the bars, then let the label band take what
      // is left over (bounded so tall windows do not fling labels away).
      const minBarRoom = usedRows * STACKED_LANE_PITCH;
      const labelBudget = stacked
        ? Math.max(lanes * labelTrackH0, roomForStack - minBarRoom - 10)
        : 0;
      const labelTrackH = stacked
        ? Math.max(
            labelTrackH0,
            Math.min(STACKED_LABEL_TRACK_MAX, labelBudget / lanes)
          )
        : labelTrackH0;
      state.labelTrackH = labelTrackH;

      const labelZone = stacked ? lanes * labelTrackH + 10 : 0;

      const barRoom = Math.max(
        usedRows * STACKED_LANE_PITCH,
        railY - topMargin - labelZone - 6
      );
      const laneStride = stacked
        ? Math.max(
            STACKED_LANE_PITCH,
            Math.min(STACKED_LANE_PITCH_MAX, barRoom / usedRows)
          )
        : 74;
      const barZone = usedRows * laneStride +
                      (stacked ? 26 : 46);
      const wantAbove = Math.max(150, barZone + labelZone);

      // The smallest viewport that still shows every lane and both bands.
      // Published so the page can size the panel against a real number
      // instead of guessing a percentage: with a handful of events this
      // is barely 300px, and there is no reason to take more.
      state.contentHeight = Math.round(wantAbove + bottomBands + 10);

      // The geometry above is the pitch the bars will actually be drawn
      // at, so the lane height is simply that pitch. Other modes keep the
      // elastic lane height they have always used, since their labels
      // ride alongside the glyphs and need the same room to clear.
      const laneH = stacked
        ? laneStride
        : Math.min(
            state.opts.laneH,
            Math.max(38, (railY - 60) / Math.max(1, state.lanes))
          );
      state.laneH = laneH;
      // How many inline label rows fit between the rail and the top of the
      // chart. `assignLanes` guessed a ceiling before the geometry
      // existed; now the real number is known, so a label that has to
      // climb knows how far it may go before it would leave the canvas.
      // `assignLanes` runs again on the re-layout pass and picks this up.
      if (!stacked) {
        // The topmost usable track has to leave room for the tag box
        // itself, not just its anchor row: a label drawn on track `k`
        // occupies `railY - 6 - k*laneH` down to ~48px below that, so the
        // deepest track is one where the whole box still fits under the
        // top of the chart.
        const TAG_BOX_H = 48;
        state.inlineLabelCeiling = Math.max(
          1,
          Math.floor(
            (railY - 6 - topMargin - TAG_BOX_H) / Math.max(1, laneH)
          )
        );
      }
      state.absLaneH = laneH;
      state.usedRows = usedRows;
      drawRail(railY, laneH);
      drawSpans(railY, laneH);
      drawPins(railY, laneH);
      drawLabelStems(railY, laneH);
      drawGaps(railY, laneH);
      drawGrid(railY);
      syncOverlay(railY, laneH);

      // syncOverlay just measured the real label widths. If any of them
      // differed from what this pass assumed, the labels may have been
      // packed too tightly - so lay the chart out once more with the true
      // widths. Exactly one extra pass happens, because on the second run
      // the measurements already match and the flag stays clear.
      if (measuredChanged) {
        measuredChanged = false;
        draw();
      }
    }

    /**
     * In stacked mode a label floats well above the bar it names, so a
     * faint vertical stem ties the two together. Without it the eye has
     * to guess which of several nearby bars a label belongs to, which is
     * exactly the ambiguity the stacked layout is meant to remove.
     */
    function drawLabelStems(railY, laneH) {
      if (state.opts.labelMode !== 'stacked') return;
      const labelTrackH = state.labelTrackH || Math.max(26, state.opts.labelLaneH);
      const barTop = railY - 6 - (state.usedRows - 1) * laneH;
      ctx.save();
      ctx.strokeStyle = theme.tick;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      for (const e of state.order) {
        const x = Math.round(contentToScreen(e.x0)) + 0.5;
        if (x < -40 || x > state.cssW + 40) continue;
        // From just under the label down to the glyph it annotates.
        const glyphLift = e.isSpan ? SPAN_BAR_H + 4 : 8;
        const glyphY = railY - 6 - e.lane * laneH - glyphLift;
        const labelBottom = barTop - 30 - (e.labelLane || 0) * labelTrackH + 26;
        if (labelBottom >= glyphY - 2) continue;
        ctx.beginPath();
        ctx.moveTo(x, labelBottom);
        ctx.lineTo(x, glyphY - 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawGrid(railY) {
      const a = state.axis;
      if (!a) return;
      // Below the gap band (railY + 34) so duration labels and ruler
      // labels never overlap.
      const tickTop = railY + 52;
      ctx.save();
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      let lastLabelRight = -Infinity;
      for (const t of a.ticks) {
        const sx = Math.round(contentToScreen(t.x)) + 0.5;
        if (sx < -60 || sx > state.cssW + 60) continue;

        // Tier decides stroke length, weight and hue. A millennium stop is
        // a long green rule, a century a medium red one, a decade a short
        // faint purple one - so the shape of the axis is legible before
        // you read a single number.
        const style = tickStyle(t);
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.width;
        ctx.beginPath();
        ctx.moveTo(sx, tickTop);
        ctx.lineTo(sx, tickTop + style.len);
        ctx.stroke();

        // The epoch is the one division on the ruler whose meaning is not
        // carried by its roundness: 1 BC and 1 AD are adjacent years that
        // happen to sit on either side of a boundary most readers have to
        // stop and think about. Give it a full-height rule and a heavier
        // label so it reads as a landmark even at a coarse step where it
        // would otherwise look like any other stop.
        if (t.epoch) {
          ctx.strokeStyle = theme.tickEpoch;
          ctx.lineWidth = 2.25;
          ctx.beginPath();
          ctx.moveTo(sx, tickTop - 10);
          ctx.lineTo(sx, tickTop + Math.max(style.len, 20));
          ctx.stroke();
        }

        // Landmark ticks also get a short stroke above the ruler line, so
        // they read as major divisions across the whole axis gutter.
        if (t.tier >= 1 || t.epoch) {
          ctx.beginPath();
          ctx.moveTo(sx, tickTop - 4);
          ctx.lineTo(sx, tickTop);
          ctx.stroke();
        }

        const label = T.yearLabel(t.y, a.step, a.subYear ? false : hasBC(a));
        // Skip labels that would overlap the previous one; the tick stays
        // so the ruler still reads continuously. Major ticks get a little
        // more room since their labels matter more.
        const w = ctx.measureText(label).width;
        const clearance = t.tier >= 1 ? 10 : 8;
        if (sx - w / 2 < lastLabelRight + clearance) continue;
        lastLabelRight = sx + w / 2;

        // Label ink follows the tick tier, and major labels are drawn in
        // a heavier face so the landmark years read first. The epoch is
        // promoted further still: bold, larger, and in its own ink, since
        // getting the BC/AD boundary wrong misreads the whole timeline.
        if (t.epoch) {
          // The chip that used to sit behind this label read as a box on
          // the axis, and the rule ending inside it made the two look like
          // a single object. The heavy amber rule and the bold label are
          // already unmistakable next to the green, red and blue ticks, so
          // the label is now drawn plainly.
          ctx.fillStyle = theme.tickEpochInk;
          ctx.font = '700 12.5px ui-monospace, SFMono-Regular, Menlo, monospace';
          const lab = '0';
          const lw = ctx.measureText(lab).width;
          ctx.fillText(lab, sx, tickTop + Math.max(style.len, 20) + 3);
          lastLabelRight = sx + lw / 2 + 6;
          continue;
        }

        ctx.fillStyle = style.ink;
        ctx.font = (t.tier >= 1 ? '600 ' : '') +
          '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(label, sx, tickTop + style.len + 2);
      }
      ctx.restore();
    }

    /** True when the current ruler shows BC years, so AD labels need the
     *  era suffix to disambiguate. */
    function hasBC(a) {
      return a.first <= 0 || a.ticks.some((t) => t.era === 'BC');
    }

    /**
     * Visual style for a ruler tick, chosen by the interval the marker
     * actually stands for:
     *
     *   10-year     purple
     *   50-year     green (light)
     *   century     red
     *   250-year    blue
     *   millennium  green (deep)
     *
     * Anything else is an uncoloured division, so the colour reads as a
     * property of the round number rather than decoration. The interval
     * is the stride between stops at this tick's tier (tierStep), which
     * assignTickTiers already worked out.
     *
     * Order matters: 250-year stops are tested before the 500/1000 checks
     * because a year like 2500 satisfies every one of them, and the most
     * specific interval is the one worth showing.
     */
    function tickStyle(t) {
      const v = t.tierStep || 1;

      // Deep time: anything at or above a million years reads as the
      // largest unit on the ruler.
      if (v >= 1e6) {
        return { len: 18, width: 1.7, stroke: theme.tickMillennium, ink: theme.tickMillennium };
      }
      // 250-year stops, checked ahead of 500/1000 so 250, 750, 2500 and
      // friends read as quarter-millennia rather than being absorbed.
      if (v % 250 === 0 && v % 1000 !== 0) {
        return { len: 14, width: 1.5, stroke: theme.tickQuarter, ink: theme.tickQuarter };
      }
      if (v % 1000 === 0) {
        return { len: 17, width: 1.6, stroke: theme.tickMillennium, ink: theme.tickMillennium };
      }
      if (v % 500 === 0) {
        return { len: 15, width: 1.5, stroke: theme.tickQuarter, ink: theme.tickQuarter };
      }
      if (v % 100 === 0) {
        return { len: 13, width: 1.4, stroke: theme.tickCentury, ink: theme.tickCentury };
      }
      if (v % 50 === 0) {
        return { len: 11, width: 1.25, stroke: theme.tickHalf, ink: theme.tickHalf };
      }
      if (v % 10 === 0) {
        return { len: 9, width: 1.1, stroke: theme.tickDecade, ink: theme.tickDecade };
      }
      // Sub-decade divisions and anything else: a neutral rule.
      return { len: 6, width: 1, stroke: theme.tick, ink: theme.tickInk };
    }

    function drawRail(railY, laneH) {
      ctx.save();
      const g = ctx.createLinearGradient(0, 0, state.cssW, 0);
      g.addColorStop(0, 'rgba(176,120,60,0.30)');
      g.addColorStop(0.5, 'rgba(120,84,40,0.52)');
      g.addColorStop(1, 'rgba(176,120,60,0.30)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, railY + 0.5);
      ctx.lineTo(state.cssW, railY + 0.5);
      ctx.stroke();

      // End caps so the rail reads as a finite ruler, not a cut-off line.
      ctx.fillStyle = theme.railCap;
      for (const cx of [0.5, state.cssW - 0.5]) {
        ctx.fillRect(cx - 1, railY - 5, 2, 11);
      }
      ctx.restore();
    }

    /** A span event draws as a rounded bar sitting on the rail. */
    function drawSpans(railY, laneH) {
      ctx.save();
      for (const e of state.order) {
        if (!e.isSpan) continue;
        const x0 = contentToScreen(e.x0);
        const x1 = contentToScreen(e.x1);
        const y = railY - 6 - e.lane * laneH;
        if (x1 < -40 || x0 > state.cssW + 40) continue;

        const w = Math.max(6, x1 - x0);
        const h = SPAN_BAR_H;
        const hot = e.id === state.hoverId || e.id === state.focusId;

        // Square ends, not a pill. A rounded bar reads as a lozenge whose
        // extremes are ambiguous, and the two boundary ticks then appear
        // to float outside the shape they are marking. Flat ends make the
        // first and last instant of the span unambiguous.
        ctx.fillStyle = hexA(e.color, hot ? 0.95 : 0.72);
        ctx.fillRect(x0, y - h, w, h);

        // Crisp boundary rules at each end, marking the exact dates.
        ctx.fillStyle = hexA(e.color, 1);
        ctx.fillRect(x0 - 1, y - h - 3, 2, h + 6);
        ctx.fillRect(x0 + w - 1, y - h - 3, 2, h + 6);

        if (hot) {
          ctx.strokeStyle = theme.hotRing;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x0 - 0.75, y - h - 0.75, w + 1.5, h + 1.5);
        }

        // The span's end lies past the last event, so its right edge is a
        // clamp rather than a real date. Mark it so the bar does not
        // imply a precise end it does not have.
        if (e.openEnd) {
          const cx = Math.min(x0 + w, state.cssW - 6);
          if (cx > -8 && cx < state.cssW + 8) {
            ctx.fillStyle = hexA(e.color, 0.95);
            ctx.beginPath();
            ctx.moveTo(cx, y - h);
            ctx.lineTo(cx + 7, y - h / 2);
            ctx.lineTo(cx, y);
            ctx.closePath();
            ctx.fill();
          }
        }

        // A bar floored to a legible width is drawn wider than its true
        // duration. Chevron its ends inward so it reads as "shorter than
        // it looks" rather than subtly lying about the dates.
        if (e.compressed) {
          ctx.strokeStyle = hexA(e.color, 0.75);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0 + w - 1, y - h - 3);
          ctx.lineTo(x0 + w - 4, y - h / 2);
          ctx.lineTo(x0 + w - 1, y + 3);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    /** A point event draws as a pin head + stem. */
    function drawPins(railY, laneH) {
      ctx.save();
      for (const e of state.order) {
        if (e.isSpan) continue;
        const x = contentToScreen(e.x0);
        if (x < -60 || x > state.cssW + 60) continue;
        const y = railY - 6 - e.lane * laneH;
        const hot = e.id === state.hoverId || e.id === state.focusId;

        ctx.strokeStyle = hexA(e.color, hot ? 0.95 : 0.5);
        ctx.lineWidth = hot ? 2 : 1.25;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, railY);
        ctx.lineTo(x + 0.5, y + 3);
        ctx.stroke();

        const r = hot ? 6.5 : 5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = hexA(e.color, hot ? 1 : 0.9);
        ctx.fill();
        ctx.strokeStyle = theme.halo;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (hot) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = hexA(e.color, 0.5);
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    /**
     * Draw the gaps: the whole point of the tool. Between consecutive
     * events we draw a bracket whose label states the elapsed time, so
     * "how long between X and Y" is answerable by looking.
     *
     * The bracket sits just *below* the rail, in its own band, and the
     * axis labels sit below that. Keeping the two bands separate stops
     * the duration labels from colliding with the ruler.
     */
    function drawGaps(railY, laneH) {
      const evs = state.order;
      if (evs.length < 2) return;
      const gapY = railY + 34;
      ctx.save();
      ctx.font = '600 11px ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let i = 1; i < evs.length; i++) {
        const a = evs[i - 1], b = evs[i];
        const gapYears = b.startY - a.startY;
        if (gapYears <= 0) continue;

        const xa = contentToScreen(a.x0), xb = contentToScreen(b.x0);
        if (xb < -80 || xa > state.cssW + 80) continue;
        const w = xb - xa;
        if (w < 26) continue;

        ctx.strokeStyle = theme.bracket;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xa, railY + 12);
        ctx.lineTo(xa, gapY);
        ctx.lineTo(xb, gapY);
        ctx.lineTo(xb, railY + 12);
        ctx.stroke();

        const label = T.formatDuration(gapYears);
        const tw = ctx.measureText(label).width;
        if (tw + 10 < w) {
          ctx.fillStyle = theme.chipBg;
          roundRect(ctx, (xa + xb) / 2 - tw / 2 - 5, gapY - 8, tw + 10, 16, 8);
          ctx.fill();
          ctx.fillStyle = theme.chipInk;
          ctx.fillText(label, (xa + xb) / 2, gapY + 0.5);
        }
      }
      ctx.restore();
    }

    /* ---- DOM overlay ------------------------------------------------
     * Tags are real elements: selectable text, keyboard focusable, and
     * <a> when the event has a source URL.
     */
    function syncOverlay(railY, laneH) {
      if (railY == null) {
        overlay.innerHTML = '';
        return;
      }
      if (overlay.childElementCount !== state.order.length) {
        overlay.innerHTML = '';
        state.order.forEach((e) => {
          const el = document.createElement(e.pageUrl ? 'a' : 'div');
          el.className = 'tag';
          el.dataset.id = e.id;
          if (e.pageUrl) {
            el.href = e.pageUrl;
            el.target = '_blank';
            el.rel = 'noopener noreferrer';
          }
          el.tabIndex = 0;
          el.innerHTML =
            `<span class="tag-dot"></span>` +
            `<span class="tag-body">` +
              `<span class="tag-label"></span>` +
              `<span class="tag-date"></span>` +
            `</span>`;

          el.addEventListener('mouseenter', () => { state.hoverId = e.id; draw(); });
          el.addEventListener('mouseleave', () => { state.hoverId = null; draw(); });
          el.addEventListener('focus', () => { state.focusId = e.id; draw(); });
          el.addEventListener('blur', () => { state.focusId = null; draw(); });
          el.addEventListener('click', (ev) => {
            // A plain click opens the detail panel; it must NOT also
            // navigate to Wikipedia, or every click costs the user the
            // page. The panel carries an explicit "Wikipedia ↗" link.
            // Modifier-clicks and middle-clicks are left alone so the
            // tag still behaves like a normal link for power users.
            const openInNewTab = ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1;
            if (!openInNewTab) ev.preventDefault();
            opts.onSelect && opts.onSelect(e, ev);
          });

          // Middle-click opens Wikipedia, matching normal link behaviour.
          el.addEventListener('auxclick', (ev) => {
            if (ev.button !== 1) return;
            ev.preventDefault();
            if (e.pageUrl) window.open(e.pageUrl, '_blank', 'noopener');
          });
          el.addEventListener('keydown', (ev) => {
            if (ev.key === 'Delete' || ev.key === 'Backspace') {
              ev.preventDefault();
              opts.onRemove && opts.onRemove(e);
            }
          });
          overlay.appendChild(el);
        });
      }

      const nodes = overlay.children;
      const stacked = state.opts.labelMode === 'stacked';
      const labelTrackH = state.labelTrackH || Math.max(26, state.opts.labelLaneH);
      // Top of the bar zone: everything above this is label-only space.
      const barTop = railY - 6 - (state.usedRows - 1) * laneH;
      for (let i = 0; i < state.order.length; i++) {
        const e = state.order[i];
        const el = nodes[i];
        const x = contentToScreen(e.x0);
        // A span draws a bar of height SPAN_BAR_H sitting just above the
        // rail, in the same lane as its tag; a point draws a pin head of
        // radius ~6 centred on the anchor. Lift the tag clear of
        // whichever glyph it labels so the text never covers it.
        const glyphLift = e.isSpan ? SPAN_BAR_H + 4 : 8;
        // In stacked mode the labels move into their own band above
        // every bar, so all the bars share a baseline and can be
        // compared directly. Otherwise the label rides with its glyph.
        // In inline mode the label rides with its glyph, but pass 2 may
        // have nudged it into a different lane to avoid a neighbour's tag,
        // so its own packed lane is used where one was assigned.
        const y = stacked
          ? barTop - 26 - (e.labelLane || 0) * labelTrackH
          : railY - 6 - (e.labelLane != null ? e.labelLane : e.lane) * laneH - glyphLift;

        // Cull offscreen tags entirely so the DOM stays small.
        const visible = x > -260 && x < state.cssW + 260;
        el.style.display = visible ? '' : 'none';
        if (!visible) continue;

        // Flip the tag to the left of its anchor near the right edge so
        // it never overflows the viewport. The threshold uses the tag's
        // *measured* width when available: assuming a fixed 160px let
        // long labels ("Fall of the Berlin Wall") hang off the edge.
        // `offsetWidth` is 0 while display:none, so fall back to TAG_W.
        const tagW = el.offsetWidth || TAG_W;
        const flip = x + tagW > state.cssW - 8;
        el.classList.toggle('flip', flip);
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        el.style.setProperty('--tag-color', e.color);

        // Record the true rendered width so the next layout can pack
        // against it instead of the TAG_W estimate. A change here means
        // the current lane assignment may be too tight, so ask for one
        // more pass. The guard flag makes that pass terminate: the second
        // time round the widths already match and no new pass is queued.
        if (tagW && labelW.get(e.id) !== tagW) {
          labelW.set(e.id, tagW);
          measuredChanged = true;
        }

        const dot = el.firstElementChild;
        dot.style.background = e.color;
        el.querySelector('.tag-label').textContent = e.label;
        el.querySelector('.tag-date').textContent = e.dateLabelShort;
        el.classList.toggle('is-span', !!e.isSpan);
        el.classList.toggle('is-active', e.id === state.hoverId || e.id === state.focusId);
      }
    }

    /* ---- interaction ------------------------------------------------ */

    function onPointerDown(ev) {
      if (ev.button !== 0) return;
      // Let tag clicks through; only start a pan on the background.
      if (ev.target.closest('.tag')) return;
      state.drag = {
        startClientX: ev.clientX,
        startViewX: state.viewX,
        moved: false,
        pointerId: ev.pointerId,
      };
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add('grabbing');
    }

    function onPointerMove(ev) {
      if (state.drag) {
        const dx = ev.clientX - state.drag.startClientX;
        if (Math.abs(dx) > 3) state.drag.moved = true;
        state.viewX = state.drag.startViewX - dx;
        clampView();
        draw();
        return;
      }
      // Hover feedback on the canvas itself (pins under the cursor).
      const hit = hitTest(ev.offsetX, ev.offsetY);
      if (hit !== state.hoverId) {
        state.hoverId = hit;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        opts.onHover && opts.onHover(hit ? findEvent(hit) : null, ev);
        draw();
      }
    }

    function onPointerUp(ev) {
      if (!state.drag) return;
      const d = state.drag;
      state.drag = null;
      canvas.classList.remove('grabbing');
      try { canvas.releasePointerCapture(d.pointerId); } catch {}
      if (!d.moved) {
        const hit = hitTest(ev.offsetX, ev.offsetY);
        if (hit) opts.onSelect && opts.onSelect(findEvent(hit), ev);
      }
    }

    function hitTest(mx, my) {
      if (!state.order.length || !state.absRailY) return null;
      const railY = state.absRailY;
      const laneH = state.absLaneH;
      let best = null, bestD = 26;
      for (const e of state.order) {
        const x = contentToScreen(e.x0);
        const y = railY - 6 - e.lane * laneH;
        if (e.isSpan) {
          const x1 = contentToScreen(e.x1);
          if (my > y - 18 && my < y + 8 && mx > x - 6 && mx < Math.max(x + 6, x1) + 6) {
            const d = Math.abs(mx - (x + x1) / 2);
            if (d < bestD + 200) { bestD = d; best = e.id; }
          }
        } else if (Math.abs(mx - x) < 14 && Math.abs(my - y) < 18) {
          const d = Math.abs(mx - x);
          if (d < bestD) { bestD = d; best = e.id; }
        }
      }
      return best;
    }

    function findEvent(id) { return state.order.find((e) => e.id === id) || null; }

    /**
     * Wheel/trackpad:
     *   - vertical scroll  -> zoom in/out (anchored at the cursor)
     *   - horizontal scroll -> pan the timeline sideways
     *   - ctrl/\u2318/shift + vertical -> zoom too, so a plain mouse wheel
     *     works without a modifier and a pinch gesture (which arrives as
     *     ctrl+wheel) still zooms.
     *
     * Dominant-axis routing means a trackpad two-finger swipe sideways
     * pans, and a two-finger swipe down zooms, without fighting each other.
     */
    function onWheel(ev) {
      ev.preventDefault();

      const ax = Math.abs(ev.deltaX);
      const ay = Math.abs(ev.deltaY);

      // A deliberate modifier always means zoom, whatever the axis.
      const forceZoom = ev.ctrlKey || ev.metaKey || ev.shiftKey;

      if (!forceZoom && ax > ay) {
        // Horizontal intention: pan. Trackpads report deltas in px.
        state.viewX += ev.deltaX;
        clampView();
        draw();
        return;
      }

      // Vertical intention (or a forced modifier): zoom about the cursor.
      if (!ay) return;
      const factor = Math.exp(-ev.deltaY * (forceZoom ? 0.0022 : 0.0016));
      zoomAt(ev.clientX, factor);
    }

    /**
     * Zoom is implemented as a multiplier on the content width, anchored
     * so whatever year sits under the cursor stays under the cursor.
     */
    function zoomAt(clientX, factor) {
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;

      // What year is under the cursor right now? We re-find this *after*
      // re-layout rather than scaling by a width ratio: the projection is
      // a log blend with a per-gap floor and a renormalisation pass, so
      // content does not scale linearly about the origin and a ratio
      // makes the anchor drift.
      const anchor = yearAtScreen(px);
      if (anchor == null) { zoomToScale(state.scale * factor); return; }

      state.scale = Math.max(0.25, Math.min(24, state.scale * factor));

      // Recompute the layout at the new scale by widening the minimum gap.
      state.opts.minGapPx = DEFAULTS.minGapPx * state.scale;
      clampView();
      layout();
      clampView();

      // Where has that same year landed now? Re-align so it sits under
      // the cursor again, then verify we actually moved the right way.
      const nowX = contentXOfYear(anchor);
      if (nowX != null) state.viewX = nowX - px;

      clampView();
      draw();
    }

    /** Zoom without an anchor, used when there is nothing under the cursor. */
    function zoomToScale(next) {
      state.scale = Math.max(0.25, Math.min(24, next));
      state.opts.minGapPx = DEFAULTS.minGapPx * state.scale;
      clampView();
      layout();
      clampView();
      draw();
    }

    function setZoom(scale) {
      state.scale = Math.max(0.25, Math.min(24, scale));
      clampView();
      layout();
      clampView();
      draw();
    }

    function scrollBy(dx) {
      state.viewX += dx;
      clampView();
      draw();
    }

    /* ---- public API ------------------------------------------------- */

    const api = {
      state,
      resize,
      draw,
      layout,

      setEvents(events, { keepView = true } = {}) {
        state.events = events;
        const oldW = state.width;
        layout();
        if (!keepView) {
          // A lone event is centred in its own window, so resetting to the
          // far left would leave the chart off screen. Centre it instead.
          state.viewX = state.soloWindow
            ? Math.max(0, (state.width - state.viewW) / 2)
            : 0;
        }
        clampView();
        if (oldW !== state.width) {
          // Width changed; keep the leftmost visible year roughly stable.
          clampView();
        }
        draw();
      },

      /**
       * Fit the whole timeline to the viewport.
       *
       * This is deliberately a touch wider than a pixel-exact fit: a
       * view where content width equals viewport width has nowhere to
       * pan, so dragging feels dead. `FIT_OVERSCAN` leaves a small
       * margin of travel past each end while keeping every event on
       * screen.
       */
      fit() {
        state.scale = FIT_OVERSCAN;
        state.opts.minGapPx = DEFAULTS.minGapPx;
        layout();
        // Centre the run so the overscan margin is split evenly and the
        // first and last events are both comfortably visible.
        state.viewX = Math.max(0, (state.width - state.viewW) / 2);
        clampView();
        draw();
      },

      // Exposed for tests and for programmatic panning.
      clampView,
      refreshTheme,

      /** Centre an event in the viewport. */
      focus(id, { smooth = true } = {}) {
        const e = findEvent(id);
        if (!e) return;
        const target = e.x0 - state.viewW / 2 + (e.isSpan ? (e.x1 - e.x0) / 2 : 0);
        const from = state.viewX;
        const to = Math.max(0, Math.min(target, Math.max(0, state.width - state.viewW)));
        if (!smooth) { state.viewX = to; clampView(); draw(); return; }
        animate(240, (t) => {
          state.viewX = from + (to - from) * t;
          clampView();
          draw();
        });
      },

      zoomIn()  { zoomAt(state.cssW / 2 + canvas.getBoundingClientRect().left, 1.35); },
      zoomOut() { zoomAt(state.cssW / 2 + canvas.getBoundingClientRect().left, 1 / 1.35); },
      setZoom,
      scrollBy,

      /**
       * Switch between 'adaptive' and 'linear' spacing. The year under the
       * middle of the viewport is held stationary, so flipping modes does
       * not throw the user somewhere else on the timeline.
       */
      setScaleMode(mode) {
        if (mode !== 'adaptive' && mode !== 'linear') return;
        if (state.opts.scaleMode === mode) return;

        const midPx = state.viewW / 2;
        const anchor = yearAtScreen(midPx);

        state.opts.scaleMode = mode;
        clampView();
        layout();
        clampView();

        if (anchor != null) {
          const nowX = contentXOfYear(anchor);
          if (nowX != null) state.viewX = nowX - midPx;
          clampView();
        }
        draw();
      },

      getScaleMode() { return state.opts.scaleMode; },

      /**
       * 'inline'  - labels share the tracks with their bars (compact).
       * 'stacked' - labels lift into their own band above the bars, so
       *             every bar shares one baseline for easy comparison.
       */
      setLabelMode(mode) {
        if (mode !== 'inline' && mode !== 'stacked') return;
        if (state.opts.labelMode === mode) return;
        state.opts.labelMode = mode;
        clampView();
        layout();
        clampView();
        draw();
      },

      getLabelMode() { return state.opts.labelMode; },

      /**
       * Select whatever sits at a point given in CSS pixels relative to
       * the canvas. The canvas normally resolves this from its own
       * pointerup, but a click can also be redirected here when it was
       * first intercepted by another layer (the search results list),
       * and a synthetic pointer event carries no usable offset.
       */
      selectAt(mx, my) {
        const hit = hitTest(mx, my);
        if (hit) opts.onSelect && opts.onSelect(findEvent(hit), null);
        return hit;
      },

      /** Minimum viewport height needed to show every lane and both
       *  bands. Lets the page avoid stealing space it does not need. */
      getContentHeight() { return state.contentHeight || 0; },

      /** The mode actually in effect: a span forces 'linear'. */
      getEffectiveMode() { return state.effectiveMode; },
      isModeForcedBySpan() { return !!state.modeForcedBySpan; },

      /**
       * Gap between consecutive events in the current sort order.
       * Coincident events (a zero-length gap) are omitted: they are not
       * gaps, and a 0-second entry reads as a bug.
       */
      gaps() {
        const out = [];
        for (let i = 1; i < state.order.length; i++) {
          const a = state.order[i - 1], b = state.order[i];
          const years = b.startY - a.startY;
          if (!(years > 0)) continue;
          out.push({
            fromId: a.id, toId: b.id,
            fromLabel: a.label, toLabel: b.label,
            years,
            label: T.formatDuration(years),
          });
        }
        return out;
      },
    };

    /* ---- helpers ---------------------------------------------------- */

    function animate(ms, fn) {
      const t0 = performance.now();
      function step(now) {
        const t = Math.min(1, (now - t0) / ms);
        // easeOutCubic
        fn(1 - Math.pow(1 - t, 3));
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    function roundRect(c, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + rr, y);
      c.arcTo(x + w, y, x + w, y + h, rr);
      c.arcTo(x + w, y + h, x, y + h, rr);
      c.arcTo(x, y + h, x, y, rr);
      c.arcTo(x, y, x + w, y, rr);
      c.closePath();
    }

    /** '#rrggbb' -> 'rgba(r,g,b,a)' */
    function hexA(hex, a) {
      const h = hex.replace('#', '');
      const n = parseInt(h.length === 3
        ? h.split('').map((c) => c + c).join('')
        : h, 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return `rgba(${r},${g},${b},${a})`;
    }

    // Pointer/wheel wiring
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.style.cursor = 'grab';

    return api;
  }

  return { create, DEFAULTS };
})();

/* ------------------------------------------------------------------ */
/* Human-facing year labels for the ruler.                             */
/* ------------------------------------------------------------------ */
T.yearLabel = function (y, step, showEra) {
  // Sub-year steps: a decimal year like "1969.55" is unreadable. Convert
  // back to a real calendar date instead.
  if (step < 1) return T.dateLabelFromYear(y, step);

  // Large numbers of years. The unit is chosen once per ruler, from the
  // step and the widest date on screen - never from the individual tick
  // value, which would switch from "-1.25 Gyr" to "-1000 Myr" partway
  // along the same scale.
  const a = Math.abs(y);
  // Choose one unit for the whole ruler. The step is the right anchor:
  // it is constant across the scale, so the unit never flips mid-axis.
  // Only when the step is sub-year (and the dates are still enormous) do
  // we fall back to the date's own magnitude.
  const unit = step >= 1 ? step : Math.max(a, 1);
  if (unit >= 5e8) return roundNice(y / 1e9) + ' Gyr';
  if (unit >= 5e5) return roundNice(y / 1e6) + ' Myr';
  if (unit >= 5e3) return roundNice(y / 1000) + ' kyr';
  if (a >= 5e8) return roundNice(y / 1e9) + ' Gyr';
  if (a >= 5e5) return roundNice(y / 1e6) + ' Myr';
  if (a >= 5e3) return roundNice(y / 1000) + ' kyr';

  const c = T.fromAstro(Math.round(y));
  if (c.era === 'BC') return `${c.y} BC`;

  // Suffix AD only where it disambiguates: when the same ruler also
  // shows BC years, a bare "50" beside "50 BC" is genuinely confusing.
  // On an all-AD ruler "1000 AD" is just noise, so the caller tells us.
  if (showEra) return `${c.y} AD`;
  return String(c.y);
};

/**
 * Render a fractional year as a calendar date, at a granularity set by
 * the tick step (day / month / year).
 */
T.dateLabelFromYear = function (y, step) {
  const year = Math.floor(y);
  const frac = y - year;
  const daysInYear = T.daysFromCivil(year + 1, 1, 1) - T.daysFromCivil(year, 1, 1);
  const dayIndex = Math.round(frac * daysInYear);
  const c = T.civilFromDays(T.daysFromCivil(year, 1, 1) + dayIndex);
  const cAstro = T.fromAstro(c.y);
  const mon = T.MONTH_NAMES[c.m - 1];

  // A step under ~2 days: include the day. Under ~2 months: day + month.
  if (step < 2 / 365.2422) {
    return `${c.d} ${mon.slice(0, 3)}${cAstro.era === 'BC' ? ' ' + cAstro.y + ' BC' : ' ' + cAstro.y}`;
  }
  if (step < 0.2) {
    return `${mon.slice(0, 3)} ${cAstro.era === 'BC' ? cAstro.y + ' BC' : cAstro.y}`;
  }
  return cAstro.era === 'BC' ? `${cAstro.y} BC` : String(cAstro.y);
};

function roundNice(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 100) return sign + Math.round(a);
  if (a >= 10) return sign + (Math.round(a * 10) / 10);
  if (a >= 1) return sign + (Math.round(a * 100) / 100);
  // Below 1 we are in the wrong unit; show enough digits to stay useful
  // rather than collapsing to "0".
  return sign + (Math.round(a * 1000) / 1000);
}

if (typeof module !== 'undefined') module.exports = Timeline;