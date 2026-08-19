const DATA_DIR = './data';
const MAX_LEGS = 4; // nejvýše 3 přestupy
const MIN_TRANSFER_MINUTES = 2;
const CHANGE_NODE_MINUTES = 3;
const MAX_TRANSFER_DISTANCE_M = 900;
const WALK_METERS_PER_MINUTE = 70;

const $ = (id) => document.getElementById(id);
const fromInput = $('fromInput');
const toInput = $('toInput');
const dateInput = $('dateInput');
const timeInput = $('timeInput');
const searchBtn = $('searchBtn');
const swapBtn = $('swapBtn');
const statusEl = $('status');
const resultsEl = $('results');
const stopsList = $('stopsList');
const dataInfo = $('dataInfo');

let manifest = null;
let stops = [];
let stopIdsByName = new Map();
let transferLinks = [];
let dayCache = new Map();

function pragueToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const get = t => parts.find(p => p.type === t)?.value;

  return `${get('year')}-${get('month')}-${get('day')}`;
}

function pragueTimePlus(minutes = 5) {
  const now = new Date(Date.now() + minutes * 60_000);

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);

  const get = t => parts.find(p => p.type === t)?.value;

  return `${get('hour')}:${get('minute')}`;
}

function timeToMinutes(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function formatTime(min) {
  const normalized = ((min % 1440) + 1440) % 1440;

  const h = Math.floor(normalized / 60);
  const m = normalized % 60;

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDuration(min) {
  if (min < 60) {
    return `${min} min`;
  }

  const h = Math.floor(min / 60);
  const m = min % 60;

  return m
    ? `${h} h ${m} min`
    : `${h} h`;
}

function normalize(s) {
  return String(s || '')
    .trim()
    .toLocaleLowerCase('cs-CZ')
    .replace(/\s+/g, ' ');
}

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[c]));
}

function haversineMeters(a, b) {
  const lat1 = Number(a?.lat);
  const lon1 = Number(a?.lon);
  const lat2 = Number(b?.lat);
  const lon2 = Number(b?.lon);

  if (
    ![lat1, lon1, lat2, lon2]
      .every(Number.isFinite)
  ) {
    return null;
  }

  if (
    (lat1 === 0 && lon1 === 0) ||
    (lat2 === 0 && lon2 === 0)
  ) {
    return null;
  }

  const rad = Math.PI / 180;

  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(dLon / 2) ** 2;

  return 2 *
    6371000 *
    Math.asin(Math.sqrt(x));
}

function physicalGroupKey(stop) {
  const key =
    String(stop?.key || '');

  const pipe =
    key.indexOf('|');

  if (pipe < 0) {
    return null;
  }

  const prefix =
    key.slice(0, pipe);

  if (
    prefix.startsWith('N:') ||
    prefix.startsWith('P:')
  ) {
    return prefix;
  }

  return null;
}

function addTransferLink(
  a,
  b,
  pairSeen
) {
  if (a === b) {
    return;
  }

  const lo =
    Math.min(a, b);

  const hi =
    Math.max(a, b);

  const pairKey =
    `${lo}:${hi}`;

  if (
    pairSeen.has(pairKey)
  ) {
    return;
  }

  const distance =
    haversineMeters(
      stops[a],
      stops[b]
    );

  if (
    distance != null &&
    distance >
      MAX_TRANSFER_DISTANCE_M
  ) {
    return;
  }

  const minutes =
    Math.max(
      CHANGE_NODE_MINUTES,

      distance == null
        ? CHANGE_NODE_MINUTES
        : Math.ceil(
            distance /
            WALK_METERS_PER_MINUTE
          )
    );

  transferLinks[a].push({
    to: b,
    minutes
  });

  transferLinks[b].push({
    to: a,
    minutes
  });

  pairSeen.add(pairKey);
}

function connectGroup(
  ids,
  pairSeen
) {
  for (
    let i = 0;
    i < ids.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < ids.length;
      j++
    ) {
      addTransferLink(
        ids[i],
        ids[j],
        pairSeen
      );
    }
  }
}

function buildTransferLinks() {
  transferLinks =
    Array.from(
      {
        length:
          stops.length
      },
      () => []
    );

  const pairSeen =
    new Set();

  /*
   * Stejně pojmenované části
   * jednoho přestupního místa.
   *
   * Typicky například:
   * tramvaj Anděl
   * +
   * metro Anděl
   */
  for (
    const ids of
    stopIdsByName.values()
  ) {
    if (
      ids.length > 1
    ) {
      connectGroup(
        ids,
        pairSeen
      );
    }
  }

  /*
   * Části stejného fyzického
   * PID/ASW uzlu.
   *
   * Pomůže i tam, kde se názvy
   * nástupišť mírně liší.
   */
  const byPhysicalGroup =
    new Map();

  for (
    const stop of stops
  ) {
    const key =
      physicalGroupKey(stop);

    if (!key) {
      continue;
    }

    if (
      !byPhysicalGroup.has(key)
    ) {
      byPhysicalGroup.set(
        key,
        []
      );
    }

    byPhysicalGroup
      .get(key)
      .push(stop.id);
  }

  for (
    const ids of
    byPhysicalGroup.values()
  ) {
    if (
      ids.length > 1
    ) {
      connectGroup(
        ids,
        pairSeen
      );
    }
  }
}

async function loadJsonGzip(url) {
  const response =
    await fetch(
      url,
      {
        cache: 'no-cache'
      }
    );

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  if (
    !(
      'DecompressionStream'
      in window
    )
  ) {
    throw new Error(
      'Tento prohlížeč neumí rozbalit komprimovaná data. Použij aktuální Chrome nebo Edge.'
    );
  }

  const ds =
    new DecompressionStream(
      'gzip'
    );

  const stream =
    response.body
      .pipeThrough(ds);

  return new Response(
    stream
  ).json();
}

async function init() {
  dateInput.value =
    pragueToday();

  timeInput.value =
    pragueTimePlus(5);

  setStatus(
    'Načítám seznam zastávek…'
  );

  try {
    const [
      manifestResp,
      stopsResp
    ] =
      await Promise.all([
        fetch(
          `${DATA_DIR}/manifest.json`,
          {
            cache: 'no-cache'
          }
        ),

        fetch(
          `${DATA_DIR}/stops.json`,
          {
            cache: 'no-cache'
          }
        )
      ]);

    if (
      !manifestResp.ok ||
      !stopsResp.ok
    ) {
      throw new Error(
        'Datové soubory zatím nejsou vytvořené.'
      );
    }

    manifest =
      await manifestResp.json();

    const stopData =
      await stopsResp.json();

    stops =
      stopData.s.map(
        (row, id) => ({
          id,
          name: row[0],
          lat: row[1],
          lon: row[2],
          key: row[3]
        })
      );

    stopIdsByName.clear();
    stopsList.innerHTML = '';

    /*
     * DŮLEŽITÉ:
     *
     * Jeden název zastávky
     * může mít několik interních
     * PID uzlů.
     *
     * Už si tedy neukládáme
     * pouze první ID.
     */
    for (
      const stop of stops
    ) {
      const key =
        normalize(
          stop.name
        );

      if (
        !stopIdsByName.has(key)
      ) {
        stopIdsByName.set(
          key,
          []
        );
      }

      stopIdsByName
        .get(key)
        .push(stop.id);
    }

    /*
     * V nabídce zobrazíme
     * každý název pouze jednou.
     */
    const uniqueNames =
      [
        ...stopIdsByName.keys()
      ]
        .map(
          key =>
            stops[
              stopIdsByName
                .get(key)[0]
            ]?.name || ''
        )
        .filter(Boolean)
        .sort(
          (a, b) =>
            a.localeCompare(
              b,
              'cs'
            )
        );

    for (
      const name of
      uniqueNames
    ) {
      const option =
        document.createElement(
          'option'
        );

      option.value = name;

      stopsList.append(
        option
      );
    }

    /*
     * Připravíme pěší vazby
     * mezi částmi přestupních
     * uzlů.
     */
    buildTransferLinks();

    if (
      manifest.dates?.length
    ) {
      dateInput.min =
        manifest.dates[0];

      dateInput.max =
        manifest.dates.at(-1);

      if (
        !manifest.dates.includes(
          dateInput.value
        )
      ) {
        dateInput.value =
          manifest.dates[0];
      }
    }

    dataInfo.textContent =
      manifest.generated
        ? `Data vytvořena ${manifest.generated}`
        : '';

    setStatus(
      `Připraveno · ${stops.length.toLocaleString(
        'cs-CZ'
      )} zastávek/uzlů`
    );
  } catch (err) {
    console.error(err);

    setStatus(
      'Datová část ještě není vygenerovaná. Spusť nejprve npm run build-data.',
      true
    );
  }
}

async function loadDay(
  date
) {
  if (
    dayCache.has(date)
  ) {
    return dayCache.get(date);
  }

  if (
    !manifest?.dates?.includes(
      date
    )
  ) {
    throw new Error(
      'Pro vybrané datum nemáme jízdní řád.'
    );
  }

  setStatus(
    `Načítám jízdní řád pro ${date}…`
  );

  const data =
    await loadJsonGzip(
      `${DATA_DIR}/${date}.json.gz`
    );

  dayCache.set(
    date,
    data
  );

  return data;
}

function resolveStops(
  input
) {
  const ids =
    stopIdsByName.get(
      normalize(
        input.value
      )
    );

  return Array.isArray(ids)
    ? ids
    : [];
}

function routeMode(
  routeType
) {
  const t =
    Number(routeType);

  if (
    t === 0 ||
    (
      t >= 900 &&
      t < 1000
    )
  ) {
    return '🚋';
  }

  if (
    t === 1 ||
    (
      t >= 400 &&
      t < 500
    )
  ) {
    return '🚇';
  }

  if (
    t === 2 ||
    (
      t >= 100 &&
      t < 200
    )
  ) {
    return '🚆';
  }

  if (
    t === 4 ||
    (
      t >= 1000 &&
      t < 1100
    )
  ) {
    return '⛴️';
  }

  if (
    t === 7 ||
    (
      t >= 1300 &&
      t < 1400
    )
  ) {
    return '🚞';
  }

  if (
    t === 11 ||
    (
      t >= 800 &&
      t < 900
    )
  ) {
    return '🚎';
  }

  return '🚌';
}

function makeBoardingTimes(
  prev,
  round,
  INF
) {
  const ready =
    new Int32Array(
      prev.length
    );

  const source =
    new Int32Array(
      prev.length
    );

  ready.fill(INF);
  source.fill(-1);

  for (
    let stopId = 0;
    stopId < prev.length;
    stopId++
  ) {
    const at =
      prev[stopId];

    if (
      at >= INF
    ) {
      continue;
    }

    /*
     * Přestup na další spoj
     * ve stejném uzlu.
     */
    const sameStopReady =
      round === 1
        ? at
        : at +
          MIN_TRANSFER_MINUTES;

    if (
      sameStopReady <
      ready[stopId]
    ) {
      ready[stopId] =
        sameStopReady;

      source[stopId] =
        stopId;
    }

    /*
     * Před prvním nástupem
     * nepřidáváme pěší přestup.
     *
     * Všechny části zadaného
     * názvu už jsou totiž
     * výchozí body.
     */
    if (
      round === 1
    ) {
      continue;
    }

    /*
     * Přechod například:
     *
     * Anděl tramvaj
     * →
     * Anděl metro
     */
    for (
      const link of
      transferLinks[
        stopId
      ] || []
    ) {
      const candidate =
        at +
        link.minutes;

      if (
        candidate <
        ready[link.to]
      ) {
        ready[link.to] =
          candidate;

        /*
         * Zapamatujeme,
         * ze kterého uzlu jsme
         * pěšky přišli.
         */
        source[link.to] =
          stopId;
      }
    }
  }

  return {
    ready,
    source
  };
}

function findJourneys(
  day,
  origins,
  destinations,
  departAt
) {
  const trips = day.t;
  const routes = day.r;

  const N =
    stops.length;

  const INF =
    1_000_000_000;

  const rounds = [];
  const preds = [];

  const originSet =
    new Set(origins);

  const destinationSet =
    new Set(
      destinations
    );

  let prev =
    new Int32Array(N);

  prev.fill(INF);

  /*
   * Všechny interní uzly
   * stejného názvu jsou
   * platný výchozí bod.
   */
  for (
    const origin of origins
  ) {
    prev[origin] =
      departAt;
  }

  rounds.push(prev);
  preds.push(
    new Array(N)
  );

  /*
   * Každé kolo =
   * další použitý spoj.
   *
   * 4 spoje =
   * nejvýše 3 přestupy.
   */
  for (
    let round = 1;
    round <= MAX_LEGS;
    round++
  ) {
    const curr =
      new Int32Array(N);

    curr.fill(INF);

    const pred =
      new Array(N);

    const boarding =
      makeBoardingTimes(
        prev,
        round,
        INF
      );

    /*
     * Projedeme všechny spoje
     * daného dne.
     */
    for (
      let tripIndex = 0;
      tripIndex <
        trips.length;
      tripIndex++
    ) {
      const trip =
        trips[tripIndex];

      const seq =
        trip[3];

      let boarded =
        false;

      let boardIndex =
        -1;

      let boardStop =
        -1;

      let boardSource =
        -1;

      for (
        let i = 0;
        i < seq.length;
        i++
      ) {
        const row =
          seq[i];

        const stopId =
          row[0];

        const arr =
          row[1];

        const dep =
          row[2];

        const pickup =
          row[3];

        const dropoff =
          row[4];

        /*
         * Je možné tento spoj
         * na této zastávce
         * stihnout?
         */
        if (
          !boarded &&
          pickup !== 1 &&
          boarding.ready[
            stopId
          ] <= dep
        ) {
          boarded = true;

          boardIndex = i;
          boardStop =
            stopId;

          /*
           * Toto může být stejný
           * uzel, nebo uzel,
           * odkud jsme sem
           * přešli pěšky.
           */
          boardSource =
            boarding.source[
              stopId
            ];
        }

        /*
         * Po nástupu ukládáme
         * nejrychlejší příjezd
         * na další zastávky.
         */
        if (
          boarded &&
          i > boardIndex &&
          dropoff !== 1 &&
          arr <
            curr[stopId]
        ) {
          curr[stopId] =
            arr;

          pred[stopId] = {
            prevStop:
              boardSource,

            boardStop,

            tripIndex,

            boardIndex,

            alightIndex:
              i,

            prevRound:
              round - 1
          };
        }
      }
    }

    rounds.push(curr);
    preds.push(pred);

    prev = curr;
  }

  const candidates = [];

  /*
   * Cíl může mít několik
   * interních PID uzlů.
   *
   * Projdeme je všechny.
   */
  for (
    let r = 1;
    r <= MAX_LEGS;
    r++
  ) {
    for (
      const destination of
      destinationSet
    ) {
      if (
        rounds[r][
          destination
        ] >= INF
      ) {
        continue;
      }

      const legs = [];

      let stopId =
        destination;

      let rr = r;

      let ok = true;

      /*
       * Rekonstrukce trasy
       * odzadu.
       */
      while (
        rr > 0
      ) {
        const p =
          preds[rr][
            stopId
          ];

        if (!p) {
          ok = false;
          break;
        }

        const trip =
          trips[
            p.tripIndex
          ];

        const route =
          routes[
            trip[0]
          ];

        const seq =
          trip[3];

        const b =
          seq[
            p.boardIndex
          ];

        const a =
          seq[
            p.alightIndex
          ];

        legs.unshift({
          route:
            route?.[1] ||
            '?',

          routeType:
            route?.[2],

          headsign:
            trip[1],

          tripShort:
            trip[2],

          from:
            b[0],

          to:
            a[0],

          dep:
            b[2],

          arr:
            a[1]
        });

        stopId =
          p.prevStop;

        rr =
          p.prevRound;
      }

      /*
       * Musíme skončit
       * v některém z platných
       * výchozích uzlů.
       */
      if (
        !ok ||
        !originSet.has(
          stopId
        ) ||
        !legs.length
      ) {
        continue;
      }

      const signature =
        legs
          .map(
            l =>
              `${l.route}:${l.from}-${l.to}@${l.dep}`
          )
          .join('|');

      candidates.push({
        signature,

        legs,

        dep:
          legs[0].dep,

        arr:
          legs.at(-1).arr,

        duration:
          legs.at(-1).arr -
          legs[0].dep,

        transfers:
          legs.length - 1
      });
    }
  }

  const seen =
    new Set();

  return candidates
    .sort(
      (a, b) =>
        a.arr -
          b.arr ||

        a.transfers -
          b.transfers ||

        b.dep -
          a.dep
    )
    .filter(
      journey => {
        if (
          seen.has(
            journey.signature
          )
        ) {
          return false;
        }

        seen.add(
          journey.signature
        );

        return true;
      }
    )
    .slice(
      0,
      4
    );
}

function renderJourneys(
  journeys
) {
  resultsEl.innerHTML =
    '';

  if (
    !journeys.length
  ) {
    resultsEl.innerHTML =
      '<div class="empty">Pro zadaný čas jsem nenašel použitelné spojení. Zkus jiný čas nebo zkontroluj názvy zastávek.</div>';

    return;
  }

  for (
    const j of journeys
  ) {
    const card =
      document.createElement(
        'article'
      );

    card.className =
      'result-card';

    card.innerHTML = `
      <div class="result-summary">
        <div class="result-time">${formatTime(
          j.dep
        )} → ${formatTime(
          j.arr
        )}</div>

        <div class="result-duration">${formatDuration(
          j.duration
        )}</div>

        <div class="result-transfers">${
          j.transfers === 0
            ? 'bez přestupu'
            : `${j.transfers} ${
                j.transfers ===
                1
                  ? 'přestup'
                  : 'přestupy'
              }`
        }</div>
      </div>

      <div class="legs"></div>
    `;

    const legsEl =
      card.querySelector(
        '.legs'
      );

    j.legs.forEach(
      (leg, idx) => {
        /*
         * Informace o přestupu.
         */
        if (
          idx > 0
        ) {
          const prevLeg =
            j.legs[
              idx - 1
            ];

          const transfer =
            document.createElement(
              'div'
            );

          transfer.className =
            'transfer-note';

          const prevName =
            stops[
              prevLeg.to
            ]?.name || '';

          const nextName =
            stops[
              leg.from
            ]?.name || '';

          const transferTime =
            Math.max(
              0,
              leg.dep -
                prevLeg.arr
            );

          transfer.textContent =
            normalize(
              prevName
            ) ===
            normalize(
              nextName
            )
              ? `Přestup · ${formatDuration(
                  transferTime
                )}`
              : `Přestup ${prevName} → ${nextName} · ${formatDuration(
                  transferTime
                )}`;

          legsEl.append(
            transfer
          );
        }

        const el =
          document.createElement(
            'div'
          );

        el.className =
          'leg';

        el.innerHTML = `
          <div
            class="mode-icon"
            aria-hidden="true"
          >
            ${routeMode(
              leg.routeType
            )}
          </div>

          <div class="line-badge">
            ${escapeHtml(
              leg.route ||
                '?'
            )}
          </div>

          <div class="leg-main">

            <div class="leg-head">
              <strong>
                směr ${escapeHtml(
                  leg.headsign ||
                    ''
                )}
              </strong>

              ${
                leg.tripShort
                  ? `<span class="direction">spoj ${escapeHtml(
                      leg.tripShort
                    )}</span>`
                  : ''
              }
            </div>

            <div class="stop-row">
              <time>
                ${formatTime(
                  leg.dep
                )}
              </time>

              <span>
                ${escapeHtml(
                  stops[
                    leg.from
                  ]?.name ||
                    ''
                )}
              </span>
            </div>

            <div class="stop-row">
              <time>
                ${formatTime(
                  leg.arr
                )}
              </time>

              <span>
                ${escapeHtml(
                  stops[
                    leg.to
                  ]?.name ||
                    ''
                )}
              </span>
            </div>

          </div>
        `;

        legsEl.append(
          el
        );
      }
    );

    resultsEl.append(
      card
    );
  }
}

async function search() {
  const origins =
    resolveStops(
      fromInput
    );

  const destinations =
    resolveStops(
      toInput
    );

  if (
    !origins.length ||
    !destinations.length
  ) {
    setStatus(
      'Vyber obě zastávky přesně ze seznamu.',
      true
    );

    return;
  }

  if (
    normalize(
      fromInput.value
    ) ===
    normalize(
      toInput.value
    )
  ) {
    setStatus(
      'Výchozí a cílová zastávka jsou stejné.',
      true
    );

    return;
  }

  if (
    !dateInput.value ||
    !timeInput.value
  ) {
    setStatus(
      'Vyber datum a čas odjezdu.',
      true
    );

    return;
  }

  searchBtn.disabled =
    true;

  try {
    const day =
      await loadDay(
        dateInput.value
      );

    setStatus(
      'Hledám nejlepší spojení…'
    );

    await new Promise(
      requestAnimationFrame
    );

    const journeys =
      findJourneys(
        day,
        origins,
        destinations,
        timeToMinutes(
          timeInput.value
        )
      );

    renderJourneys(
      journeys
    );

    setStatus(
      journeys.length
        ? `Nalezeno ${journeys.length} variant.`
        : 'Spojení nenalezeno.'
    );
  } catch (err) {
    console.error(err);

    setStatus(
      err.message ||
        'Nepodařilo se načíst jízdní řád.',
      true
    );
  } finally {
    searchBtn.disabled =
      false;
  }
}

swapBtn.addEventListener(
  'click',
  () => {
    [
      fromInput.value,
      toInput.value
    ] = [
      toInput.value,
      fromInput.value
    ];
  }
);

searchBtn.addEventListener(
  'click',
  search
);

[
  fromInput,
  toInput,
  dateInput,
  timeInput
].forEach(
  el => {
    el.addEventListener(
      'keydown',
      e => {
        if (
          e.key ===
          'Enter'
        ) {
          search();
        }
      }
    );
  }
);

init();
