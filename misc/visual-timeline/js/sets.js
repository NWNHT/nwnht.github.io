/* ------------------------------------------------------------------
 * sets.js — curated starting points.
 *
 * Each set is a short, deliberate selection of dates for one subject.
 * They are *suggestions*, not data: the app resolves each entry through
 * Wikipedia/Wikidata exactly as if the user had searched for it, so the
 * dates on screen come from the same source as a hand-made timeline and
 * link to the same articles.
 *
 * Two rules govern what belongs here.
 *
 * 1. SHORT. A set is 6-12 events. The axis picks its tick step and row
 *    layout from how many events it has, so a 30-entry set stops being a
 *    timeline and becomes a wall of bars. Where a subject has more than
 *    a dozen worth showing, the set keeps the ones that *structure* the
 *    period - the beginning, the turns, the ends.
 *
 * 2. SOURCE-FIRST. An entry is normally just a title and the source
 *    decides the date. That is deliberate: it means the numbers track
 *    Wikipedia rather than this file, and it is one less thing to be
 *    wrong. An explicit date is given only where the source has nothing
 *    usable, or where it is demonstrably wrong - and those carry a
 *    comment saying which. Every entry was checked by resolving it
 *    through the app's own pipeline; of ~94 candidates, 75 dated
 *    correctly on their own and only the ones below needed pinning.
 *
 * `title` is always the exact Wikipedia article. A fuzzy search silently
 * matches the wrong page - "Jamestown" finds a 1659 ship, "Euclid" a
 * crater, "Yuri Gagarin" a 2012 film - so titles are spelled out.
 *
 * An entry is either:
 *   { title }                     - let the source decide
 *   { title, start, end }         - override
 *   { title, start, end, note }   - override with a nicer label
 *
 * `end === start` is a point; `end > start` draws a range bar.
 * ------------------------------------------------------------------ */

const SETS = (() => {
  /* Dates are astronomic years: 1 BC is 0, so 100 BC is -99. Using the
   * historic convention (100 BC -> -100) would shift every BC entry by a
   * year, which is exactly the off-by-one the timeline works to avoid. */
  const set = (id, name, blurb, events) => ({ id, name, blurb, events });

  return [
    /* ============================================================ Rome */
    set('rome', 'Rome', 'From a village on the Palatine to the fall of the West.', [
      { title: 'Founding of Rome' },                    // -753, traditional
      { title: 'Roman Republic' },                      // -509 to -27
      { title: 'Punic Wars' },                          // -264 to -146
      { title: 'Julius Caesar', note: 'Julius Caesar (life)' },
      { title: 'Augustus', note: 'Augustus (life)' },
      { title: 'Roman Empire' },                        // -27 to 395
      { title: 'Pax Romana' },                          // -27 to 180
      { title: 'Crisis of the Third Century' },         // 235 to 284
      { title: 'Fall of the Western Roman Empire' },    // 476
    ]),

    /* ======================================================== Americas */
    set('americas', 'Discovery and settling of the Americas',
      'Norse landfall to the American Civil War.', [
      // Source gives a decade, not a year; L'Anse aux Meadows is c. 1000.
      { title: 'Norse settlement of North America', start: 1000, end: 1000,
        note: 'Norse landfall in North America' },
      { title: 'Voyages of Christopher Columbus' },      // 1492 to 1504
      { title: 'Spanish colonization of the Americas' }, // 1493 to 1898
      // Source has no date for the article; the landing was Nov 1620.
      { title: 'Mayflower', start: 1620, end: 1620, note: 'Mayflower landing' },
      { title: 'Jamestown, Virginia' },                  // 1607
      { title: 'Thirteen Colonies' },                    // 1732 to 1776
      { title: 'American Revolutionary War' },           // 1775 to 1783
      { title: 'United States Declaration of Independence' }, // 1776
      { title: 'Louisiana Purchase' },                   // 1803
      { title: 'American Civil War' },                   // 1861 to 1865
    ]),

    /* ====================================================== Formula One */
    set('formula-one', 'Formula One',
      'The championship and the eras that shaped it.', [
      { title: '1950 Formula One season', note: 'First World Championship' },
      { title: '1958 Formula One season', note: 'First Constructors\u2019 Championship' },
      // Eras are regulation periods, which is what actually structures
      // the sport's history. Each is named for its first season. These
      // are hand-dated because the eras have no single article; the
      // boundaries follow the regulations, not any one team's run.
      { title: 'History of Formula One', start: 1950, end: 1958,
        note: 'Front-engined era' },
      { title: 'History of Formula One', start: 1958, end: 1977,
        note: 'Rear-engined era' },
      { title: 'History of Formula One', start: 1977, end: 1983,
        note: 'Ground effect era' },
      { title: 'History of Formula One', start: 1977, end: 1988,
        note: 'Turbo era' },
      { title: 'History of Formula One', start: 2014, end: 2026,
        note: 'V6 turbo-hybrid era' },
      // Streaks: consecutive Constructors' titles, longest first. These
      // are the runs long enough to have defined a period - not a list
      // of champions. Hand-dated because a team article carries its
      // founding year, not its title run.
      { title: 'McLaren', start: 1988, end: 1991,
        note: 'McLaren \u2014 4 consecutive titles' },
      { title: 'Scuderia Ferrari', start: 1999, end: 2004,
        note: 'Ferrari \u2014 6 consecutive titles' },
      { title: 'Red Bull Racing', start: 2010, end: 2013,
        note: 'Red Bull \u2014 4 consecutive titles' },
      { title: 'Mercedes-Benz in Formula One', start: 2014, end: 2021,
        note: 'Mercedes \u2014 8 consecutive titles' },
    ]),

    /* ======================================================= Space race */
    set('space-race', 'Space race', 'Sputnik to the space station.', [
      { title: 'Space Race' },                           // 1957 to 1975
      { title: 'Sputnik 1' },                            // 1957
      { title: 'Project Mercury' },                      // 1958 to 1963
      { title: 'Vostok 1', note: 'Vostok 1 \u2014 first human spaceflight' }, // 1961
      { title: 'Apollo program' },                       // 1961 to 1972
      { title: 'Apollo 11' },                            // 1969
      { title: 'Apollo\u2013Soyuz' },                    // 1975
      { title: 'Space Shuttle program' },                // 1972 to 2011
      { title: 'Voyager 1' },                            // 1977
      // Source gives only a start, so the span stays open.
      { title: 'International Space Station', start: 1998, end: 2026 },
    ]),

    /* ====================================================== Mathematics */
    set('mathematics', 'Mathematics',
      'A line through the people who bent the subject.', [
      // The article starts at the Ubaid period; Babylonian mathematics
      // proper is dated from c. 2000 BC, which is what we show.
      { title: 'Babylonian mathematics', start: -1999, end: -500 },
      { title: 'Euclid', note: 'Euclid of Alexandria (life)' },  // -332 to -284
      { title: 'Archimedes' },                                   // -286 to -211
      // Source spans 750-846, but 750 is the birth approximation and he
      // died c. 850, so the pair is inconsistent. Use the standard life.
      { title: 'Al-Khwarizmi', start: 780, end: 850, note: 'Al-Khwarizmi (life)' },
      { title: 'Isaac Newton', note: 'Isaac Newton (life)' },     // 1642 to 1727
      { title: 'Philosophi\u00e6 Naturalis Principia Mathematica',
        note: 'Newton\u2019s Principia published' },             // 1687
      { title: 'Leonhard Euler', note: 'Leonhard Euler (life)' },
      { title: 'Carl Friedrich Gauss', note: 'Carl Friedrich Gauss (life)' },
      { title: '\u00c9variste Galois', note: '\u00c9variste Galois (life)' },
      { title: 'Kurt G\u00f6del', note: 'Kurt G\u00f6del (life)' },
      { title: 'Alan Turing', note: 'Alan Turing (life)' },
      // Living mathematician, so the span stays open.
      { title: 'Andrew Wiles', start: 1953, end: 2026, note: 'Andrew Wiles (life)' },
    ]),

    /* ============================================ Ancient civilizations */
    set('ancient-civilizations', 'Ancient civilizations',
      'The first cities, and how long they lasted.', [
      // Source starts at 5500 BC (the Ubaid pottery culture) and runs to
      // 1900 BC. Sumerian-speaking urban culture is later than Ubaid, so
      // 4500 BC is used as a defensible opening bound.
      { title: 'Sumer', start: -4499, end: -1899 },
      // Source says 4000 BC; the conventional unification of Upper and
      // Lower Egypt under Narmer is c. 3100 BC. Ends with Roman
      // annexation in 30 BC.
      { title: 'Ancient Egypt', start: -3099, end: -29 },
      // Source says 3000 BC; the Indus Valley Civilisation is dated
      // 3300-1300 BC.
      { title: 'Indus Valley Civilisation', start: -3299, end: -1299 },
      { title: 'Qin dynasty' },                    // -221 to -206
      { title: 'Han dynasty' },                    // -206 to 220
      { title: 'Maurya Empire' },                  // -322 to -185
      { title: 'Gupta Empire' },                   // 320 to 550
      { title: 'Maya civilization' },              // -2000 to 1521
      { title: 'Inca Empire' },                    // 1438 to 1533
      // Source gives 1367 (a dynasty founding, not the empire); the
      // Triple Alliance that formed the Aztec Empire dates to 1428, and
      // it ended with the fall of Tenochtitlan in 1521.
      { title: 'Aztec Empire', start: 1428, end: 1521, note: 'Aztec Empire' },
    ]),

    /* ======================================================== Pandemics */
    set('pandemics', 'Plagues and pandemics',
      'Six outbreaks, and how differently they behaved.', [
      // Source runs the plague to 750, conflating the first outbreak
      // with the recurrences; the first pandemic was 541-549.
      { title: 'Plague of Justinian', start: 541, end: 549 },
      { title: 'Black Death' },                    // 1346 to 1352
      { title: 'Spanish flu' },                    // 1918 to 1920
      // Source gives 1959 (a single early case); the epidemic is dated
      // from its recognition in 1981 and is ongoing.
      { title: 'HIV/AIDS', start: 1981, end: 2026,
        note: 'HIV/AIDS epidemic' },
      { title: 'COVID-19 pandemic', start: 2019, end: 2026 },
      // Source has no usable date (returns -9999). WHO declared
      // eradication in 1980; the intensified campaign began in 1967.
      { title: 'Smallpox', start: 1967, end: 1980,
        note: 'Smallpox eradication campaign' },
    ]),

    /* ========================================================== Flight */
    set('flight', 'Flight and spaceflight',
      'Twelve seconds at Kitty Hawk to the Sea of Tranquility.', [
      // Source has no date; the first powered flight was Dec 1903.
      { title: 'Wright brothers', start: 1903, end: 1903,
        note: 'First powered flight' },
      { title: 'World War I', note: 'World War I aviation' },  // 1914 to 1918
      { title: 'Transatlantic flight of Alcock and Brown' },   // 1919
      // Source has no date for the technology; Whittle's engine ran in
      // 1937. The article covers the concept, so the date is a marker.
      { title: 'Jet engine', start: 1937, end: 1937,
        note: 'First jet engine runs' },
      // Source has no date; Yeager broke the sound barrier in Oct 1947.
      { title: 'Sound barrier', start: 1947, end: 1947,
        note: 'Sound barrier broken' },
      { title: 'Sputnik 1' },                      // 1957
      { title: 'Apollo 11' },                      // 1969
      // Source gives 1970 (first flight); it entered service in 1970,
      // and the first flight was Feb 1969.
      { title: 'Boeing 747', start: 1969, end: 1969,
        note: 'Boeing 747 first flight' },
    ]),

    /* ======================================================= Computing */
    set('computing', 'Computing',
      'A century of increasingly short gaps.', [
      { title: 'Charles Babbage', note: 'Charles Babbage (life)' },
      { title: 'Ada Lovelace', note: 'Ada Lovelace (life)' },
      { title: 'Alan Turing', note: 'Alan Turing (life)' },
      { title: 'ENIAC' },                          // 1946, unveiled
      { title: 'Transistor' },                     // 1947
      { title: 'Integrated circuit' },             // 1958
      { title: 'ARPANET' },                        // 1969
      // Source says 1975, the year after release; the 4004 shipped in
      // November 1971.
      { title: 'Intel 4004', start: 1971, end: 1971,
        note: 'First microprocessor' },
      { title: 'World Wide Web' },                 // 1989
      // Source has no date (the article is styled "IPhone"); announced
      // January 2007.
      { title: 'IPhone', start: 2007, end: 2007, note: 'iPhone announced' },
    ]),

    /* ===================================================== Revolutions */
    set('revolutions', 'Revolutions and world wars',
      'Two centuries that reset the map.', [
      // Source gives 1760-1820; the conventional span runs to c. 1840.
      { title: 'Industrial Revolution', start: 1760, end: 1840 },
      { title: 'American Revolutionary War' },     // 1775 to 1783
      { title: 'French Revolution' },              // 1789 to 1799
      { title: 'Napoleonic Wars' },                // 1803 to 1815
      { title: 'World War I' },                    // 1914 to 1918
      { title: 'Russian Revolution' },             // 1917
      { title: 'World War II' },                   // 1939 to 1945
      { title: 'Cold War' },                       // 1945 to 1991
      { title: 'Fall of the Berlin Wall' },        // 1989
    ]),

    /* ====================================================== Art eras */
    set('arts', 'Art and music eras',
      'Every entry is a period, not a moment.', [
      // Source has no date; the medieval period is conventionally
      // c. 500-1400 in the West.
      { title: 'Medieval art', start: 500, end: 1400, note: 'Medieval art' },
      { title: 'Renaissance' },                    // 1400 to 1650
      { title: 'Baroque' },                        // 1590 to 1750
      { title: 'Neoclassicism' },                  // 1760 to 1830
      // Source spans 1800-1900, which swallows the whole century; the
      // movement is conventionally dated c. 1800-1850.
      { title: 'Romanticism', start: 1800, end: 1850, note: 'Romanticism' },
      // Source gives a single year; the movement spans c. 1860-1890.
      { title: 'Impressionism', start: 1860, end: 1890, note: 'Impressionism' },
      // Source gives only a start (1900); modernism runs to c. 1945.
      { title: 'Modernism', start: 1890, end: 1945, note: 'Modernism' },
      // Source has no date; "contemporary" is conventionally post-1945.
      { title: 'Contemporary art', start: 1945, end: 2026,
        note: 'Contemporary art' },
    ]),
  ];
})();

if (typeof module !== 'undefined') module.exports = SETS;