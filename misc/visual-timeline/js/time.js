/* ------------------------------------------------------------------
 * time.js — a tolerant date/time model built for timelines.
 *
 * JavaScript Date only covers ±100M days (~±273,790 years) around the
 * epoch, and loses precision for far dates. Historical timelines need
 * "3.5 billion years ago" just as much as "1969-07-20 20:17 UTC".
 *
 * So we represent every instant as { y, mo, d, h, mi, s } with a
 * *precision* level telling us which fields are trustworthy, and we
 * convert to a continuous number only for layout — never for display.
 *
 * Layout uses a signed "years" float, which is exact enough for
 * positioning (a pixel is ~1/50th of a day at worst).
 * ------------------------------------------------------------------ */

const T = (() => {

  // Precision ranks. Higher = more fields meaningful.
  const P = {
    BILLION: 0,   // "3.5 bya"        — only ~100My meaningful
    MILLION: 1,   // "65 mya"         — ~100ky
    MILLENNIUM: 2,// "3rd millennium BC"
    CENTURY: 3,   // "5th century BC" — ~10y
    DECADE: 4,    // "1960s"
    YEAR: 5,      // "1969"
    MONTH: 6,     // "July 1969"
    DAY: 7,       // "1969-07-20"
    HOUR: 8,      // "1969-07-20 20:17"
    SECOND: 9,    // "1969-07-20 20:17:40"
  };

  const PRECISION_NAME = {
    0: 'billions of years',
    1: 'millions of years',
    2: 'millennium',
    3: 'century',
    4: 'decade',
    5: 'year',
    6: 'month',
    7: 'day',
    8: 'minute',
    9: 'second',
  };

  /* --- astronomical year numbering ---------------------------------
   * ISO 8601 uses year 0 = 1 BC, -1 = 2 BC, ... That keeps arithmetic
   * trivial. We display with a BC/AD conversion at the edges.
   */
  function toAstro(y, era) {
    if (era === 'BC' || era === 'BCE') return 1 - y;   // 1 BC -> 0
    return y;
  }

  function fromAstro(y) {
    return y <= 0
      ? { y: 1 - y, era: 'BC' }
      : { y, era: 'AD' };
  }

  /* --- day-number <-> civil date -----------------------------------
   * Proleptic Gregorian calendar, day 0 = 1970-01-01.
   * Standard Howard Hinnant algorithms — valid over the full range of
   * our year floats without floating point drift for |y| < 1e6.
   */
  function daysFromCivil(y, m, d) {
    // m: 1..12, d: 1..31
    y -= m <= 2 ? 1 : 0;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;                                  // [0, 399]
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  function civilFromDays(z) {
    z += 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;                                // [0, 146096]
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp + (mp < 10 ? 3 : -9);
    return { y: y + (m <= 2 ? 1 : 0), m, d };
  }

  /* --- instant -> continuous year (for layout only) ----------------
   * Not for display: the float loses meaning past the stated precision.
   * Layout only needs monotonic positions a few px apart to be right.
   */
  function instantToYear(dt) {
    const y = dt.y;
    if (dt.precision <= P.YEAR) return y;
    if (dt.precision === P.MONTH) return y + ((dt.mo || 1) - 1) / 12;
    // day or finer: use real calendar arithmetic
    const yLen = daysFromCivil(y + 1, 1, 1) - daysFromCivil(y, 1, 1);
    const doy = daysFromCivil(y, dt.mo || 1, dt.d || 1) - daysFromCivil(y, 1, 1);
    let frac = doy / yLen;
    if (dt.precision >= P.HOUR) frac += ((dt.h || 0) + (dt.mi || 0) / 60 + (dt.s || 0) / 3600) / (24 * yLen);
    return y + frac;
  }

  /* --- year (layout) -> human label -------------------------------- */

  function mk(y, precision, opts = {}) {
    return Object.assign({
      y, mo: null, d: null, h: null, mi: null, s: null,
      precision, approx: false,
    }, opts);
  }

  /* --- parsing -----------------------------------------------------
   * Accepts the shapes Wikipedia/DBpedia/time parsers actually emit:
   *   1969                 July 1969           1969-07-20
   *   20 July 1969         1969-07-20T20:17:40Z
   *   5th century BC       1960s               3rd millennium BC
   *   65 million years ago 4.5 bya
   *   c. 1200 / ca. 1200 / circa 1200 / ~1200
   */

  const MONTHS = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
    may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
    september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
    december: 12, dec: 12,
  };

  const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
    seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
    thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
    seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
    'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23,
    'twenty-fourth': 24, 'twenty-fifth': 25 };

  const NUMWORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
    thousand: 1000, million: 1e6, billion: 1e9 };

  function monthFromWord(w) {
    const k = String(w).toLowerCase().replace(/\.$/, '');
    return MONTHS[k] || null;
  }

  /**
   * parse(str) -> instant | null
   * Best-effort. Returns null when nothing date-like is found.
   */
  function parse(input) {
    if (!input) return null;
    if (typeof input === 'object' && input.y != null) return input;

    let s = String(input).trim();

    // ---- approximate markers
    let approx = false;
    s = s.replace(/^(c\.|ca\.|circa|approx\.?|about|~)\s*/i, () => { approx = true; return ''; });
    if (/^~/.test(s)) { approx = true; s = s.slice(1); }

    // ---- "X years ago" / "X bya" / "X mya" / "X kya"
    let m = s.match(/^([\d.,]+)\s*(billion|million|thousand)?\s*(?:years?\s*)?(ago|bya|mya|kya|ya)\b/i);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      let unitMul = 1;
      const u = (m[2] || '').toLowerCase();
      if (u === 'billion') unitMul = 1e9;
      else if (u === 'million') unitMul = 1e6;
      else if (u === 'thousand') unitMul = 1e3;
      else {
        const t = m[3].toLowerCase();
        if (t === 'bya') unitMul = 1e9;
        else if (t === 'mya') unitMul = 1e6;
        else if (t === 'kya') unitMul = 1e3;
      }
      const yearsAgo = n * unitMul;
      const y = 1950 - yearsAgo;             // "ago" convention = before present (1950)
      const precision = unitMul >= 1e9 ? P.BILLION : unitMul >= 1e6 ? P.MILLION : P.YEAR;
      const scale = unitMul >= 1e9 ? 1e8 : unitMul >= 1e6 ? 1e5 : 1;
      return { ...mk(y, precision), approx, span: null, _yearsAgo: yearsAgo, _coarse: scale };
    }

    // ---- ISO-ish: 1969-07-20T20:17:40Z  |  1969-07-20  |  -0044-03-15
    m = s.match(/^(-?\d{1,6})-(\d{1,2})(?:-(\d{1,2}))?(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(Z|[+-]\d{2}:?\d{2})?)?/);
    if (m) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d  = m[3] ? parseInt(m[3], 10) : null;
      const h  = m[4] != null ? parseInt(m[4], 10) : null;
      const mi = m[5] != null ? parseInt(m[5], 10) : null;
      const sc = m[6] != null ? Math.floor(parseFloat(m[6])) : null;
      let precision = P.MONTH;
      if (d != null) precision = P.DAY;
      if (h != null) precision = P.HOUR;
      if (sc != null) precision = P.SECOND;
      return { y, mo, d, h, mi, s: sc, precision, approx, tz: m[7] || null };
    }

    // ---- "20 July 1969" / "July 20, 1969" / "July 1969"
    m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{1,6})\s*(BC|BCE|AD|CE)?\b/);
    if (m) {
      const d = parseInt(m[1], 10);
      const mo = monthFromWord(m[2]);
      if (mo) return finish(toAstro(parseInt(m[3], 10), m[4]), mo, d, P.DAY, approx);
    }
    m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{1,6})\s*(BC|BCE|AD|CE)?\b/);
    if (m) {
      const mo = monthFromWord(m[1]);
      if (mo) return finish(toAstro(parseInt(m[3], 10), m[4]), mo, parseInt(m[2], 10), P.DAY, approx);
    }
    m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,6})\s*(BC|BCE|AD|CE)?\b/);
    if (m) {
      const mo = monthFromWord(m[1]);
      if (mo) return finish(toAstro(parseInt(m[2], 10), m[3]), mo, null, P.MONTH, approx);
    }

    // ---- "5th century BC", "21st century"
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+century\s*(BC|BCE|AD|CE)?\b/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const isBC = /^BC/.test(m[2] || '');
      // The 5th century BC = 500-401 BC; midpoint 450 BC
      const startAstro = isBC ? toAstro(n * 100, 'BC') : (n - 1) * 100 + 1;
      const endAstro = isBC ? toAstro((n - 1) * 100 + 1, 'BC') : n * 100;
      return { y: (startAstro + endAstro) / 2, mo: null, d: null, h: null, mi: null, s: null,
               precision: P.CENTURY, approx, _spanYears: [startAstro, endAstro] };
    }

    // ---- "3rd millennium BC", "2nd millennium"
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+millennium\s*(BC|BCE|AD|CE)?\b/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const isBC = /^BC/.test(m[2] || '');
      const startAstro = isBC ? toAstro(n * 1000, 'BC') : (n - 1) * 1000 + 1;
      const endAstro = isBC ? toAstro((n - 1) * 1000 + 1, 'BC') : n * 1000;
      return { y: (startAstro + endAstro) / 2, mo: null, d: null, h: null, mi: null, s: null,
               precision: P.MILLENNIUM, approx, _spanYears: [startAstro, endAstro] };
    }

    // ---- "1960s", "1960s BC"
    m = s.match(/^(\d{2,6})0s\s*(BC|BCE|AD|CE)?\b/i);
    if (m) {
      const base = parseInt(m[1], 10) * 10;
      const isBC = /^BC/.test(m[2] || '');
      const startAstro = isBC ? toAstro(base + 9, 'BC') : base;
      const endAstro   = isBC ? toAstro(base, 'BC')     : base + 9;
      return { y: (startAstro + endAstro) / 2, mo: null, d: null, h: null, mi: null, s: null,
               precision: P.DECADE, approx, _spanYears: [startAstro, endAstro] };
    }

    // ---- bare year, optional era: "1969", "450 BC", "117 CE"
    m = s.match(/^(-?\d{1,6})\s*(BC|BCE|AD|CE)?\s*$/i);
    if (m) {
      return finish(toAstro(parseInt(m[1], 10), m[2]), null, null, P.YEAR, approx);
    }

    // ---- last resort: pull the first 3-4 digit number out
    m = s.match(/\b(\d{3,6})\s*(BC|BCE|AD|CE)?\b/i);
    if (m) return finish(toAstro(parseInt(m[1], 10), m[2]), null, null, P.YEAR, approx);

    return null;
  }

  function finish(y, mo, d, precision, approx) {
    return { y, mo, d, h: null, mi: null, s: null, precision, approx };
  }

  /* --- formatting --------------------------------------------------- */

  function fmtYearAstro(yInt) {
    const c = fromAstro(yInt);
    return c.era === 'BC' ? `${c.y} BC` : `${c.y}`;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  /**
   * format(instant, opts) -> short human label, e.g.
   *   "20 Jul 1969"  "July 1969"  "1969"  "1960s"  "5th century BC"  "3.5 bya"
   */
  function format(dt, opts = {}) {
    if (!dt) return '';
    const long = !!opts.long;
    const sign = dt.approx ? 'c. ' : '';

    switch (dt.precision) {
      case P.BILLION: {
        const ago = (1950 - dt.y) / 1e9;
        return sign + trimNum(ago) + ' billion years ago';
      }
      case P.MILLION: {
        const ago = (1950 - dt.y) / 1e6;
        return sign + trimNum(ago) + ' million years ago';
      }
      case P.MILLENNIUM: {
        const c = fromAstro(Math.round(dt.y));
        const n = c.era === 'BC'
          ? Math.ceil(c.y / 1000)
          : Math.floor((c.y - 1) / 1000) + 1;
        return sign + `${ordinal(n)} millennium ${c.era === 'BC' ? 'BC' : ''}`.trim();
      }
      case P.CENTURY: {
        const c = fromAstro(Math.round(dt.y));
        const n = c.era === 'BC'
          ? Math.ceil(c.y / 100)
          : Math.floor((c.y - 1) / 100) + 1;
        return sign + `${ordinal(n)} century ${c.era === 'BC' ? 'BC' : ''}`.trim();
      }
      case P.DECADE: {
        const c = fromAstro(Math.round(dt.y));
        const decade = Math.floor(c.y / 10) * 10;
        return sign + `${Math.abs(decade)}s${c.era === 'BC' ? ' BC' : ''}`;
      }
      case P.YEAR:
        return sign + fmtYearAstro(Math.round(dt.y));
      case P.MONTH: {
        const mo = MONTH_NAMES[(dt.mo || 1) - 1];
        const c = fromAstro(dt.y);
        return sign + `${long ? mo : mo.slice(0, 3)} ${c.era === 'BC' ? c.y : c.y}` +
               (c.era === 'BC' ? ' BC' : '');
      }
      case P.DAY:
      default: {
        const c = fromAstro(dt.y);
        const mo = MONTH_NAMES[(dt.mo || 1) - 1];
        const base = `${dt.d} ${long ? mo : mo.slice(0, 3)} ${Math.abs(c.y)}${c.era === 'BC' ? ' BC' : ''}`;
        if (dt.precision >= P.HOUR && dt.h != null) {
          const t = `${pad2(dt.h)}:${pad2(dt.mi || 0)}`;
          const ts = dt.s != null ? `:${pad2(dt.s)}` : '';
          return `${base} ${t}${ts}${dt.tz === 'Z' || dt.tz ? ' UTC' : ''}`;
        }
        return base;
      }
    }
  }

  const MONTH_NAMES = ['January','February','March','April','May','June','July',
    'August','September','October','November','December'];

  function ordinal(n) {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function trimNum(x) {
    if (x >= 100) return String(Math.round(x));
    if (x >= 10) return String(Math.round(x * 10) / 10);
    return String(Math.round(x * 100) / 100);
  }

  /* --- precision-aware "extent" of an instant ----------------------
   * An event dated "1960s" isn't a point; it occupies ~10 years. We
   * return [startYear, endYear] so the renderer can draw a meaningful
   * bar even for coarse dates. Precision >= DAY returns a zero-width
   * point (the caller draws a pin instead).
   */
  function extent(dt) {
    if (dt._spanYears) return dt._spanYears.slice().sort((a, b) => a - b);

    const y = instantToYear(dt);
    switch (dt.precision) {
      case P.BILLION:  return [y - 1e8, y + 1e8];
      case P.MILLION:  return [y - 1e5, y + 1e5];
      case P.MILLENNIUM: return [y - 500, y + 500];
      case P.CENTURY:  return [y - 50, y + 50];
      case P.DECADE:   return [y - 5, y + 5];
      case P.YEAR:     return [Math.floor(y), Math.floor(y) + 1];
      case P.MONTH:    return [y, y + 1 / 12];
      case P.DAY:      return [y, y + 1 / 365.25];
      default:         return [y, y + 1 / (365.25 * 24 * 60)];
    }
  }

  /* --- gap formatting ----------------------------------------------
   * Given a difference in years, say it the way a person would.
   */
  function formatDuration(years) {
    const a = Math.abs(years);
    if (a >= 1e9) return trimNum(a / 1e9) + ' billion years';
    if (a >= 1e6) return trimNum(a / 1e6) + ' million years';
    if (a >= 1e4) return trimNum(a / 1e3) + ' thousand years';
    if (a >= 200) return Math.round(a) + ' years';
    if (a >= 2)   return (Math.round(a * 10) / 10) + ' years';
    const days = a * 365.2422;
    if (days >= 60) return (Math.round(a * 12 * 10) / 10) + ' months';
    if (days >= 1.5) return Math.round(days) + ' days';
    const hours = days * 24;
    if (hours >= 1.5) return Math.round(hours) + ' hours';
    const mins = hours * 60;
    if (mins >= 1.5) return Math.round(mins) + ' minutes';
    return Math.round(mins * 60) + ' seconds';
  }

  return {
    P, PRECISION_NAME, MONTH_NAMES,
    parse, mk, format, formatDuration, extent,
    instantToYear, toAstro, fromAstro,
    daysFromCivil, civilFromDays,
  };
})();

if (typeof module !== 'undefined') module.exports = T;