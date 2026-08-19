const DATA_DIR = './data';
const MAX_LEGS = 4; // nejvýše 3 přestupy
const TRANSFER_MINUTES = 2;

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
let stopByName = new Map();
let dayCache = new Map();

function pragueToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function pragueTimePlus(minutes = 5) {
  const now = new Date(Date.now() + minutes * 60_000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('hour')}:${get('minute')}`;
}

function timeToMinutes(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function formatTime(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function normalize(s) {
  return s.trim().toLocaleLowerCase('cs-CZ').replace(/\s+/g, ' ');
}

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

async function loadJsonGzip(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!('DecompressionStream' in window)) {
    throw new Error('Tento prohlížeč neumí rozbalit komprimovaná data. Použij aktuální Chrome nebo Edge.');
  }
  const ds = new DecompressionStream('gzip');
  const stream = response.body.pipeThrough(ds);
  return new Response(stream).json();
}

async function init() {
  dateInput.value = pragueToday();
  timeInput.value = pragueTimePlus(5);
  setStatus('Načítám seznam zastávek…');

  try {
    const [manifestResp, stopsResp] = await Promise.all([
      fetch(`${DATA_DIR}/manifest.json`, { cache: 'no-cache' }),
      fetch(`${DATA_DIR}/stops.json`, { cache: 'no-cache' })
    ]);
    if (!manifestResp.ok || !stopsResp.ok) throw new Error('Datové soubory zatím nejsou vytvořené.');

    manifest = await manifestResp.json();
    const stopData = await stopsResp.json();
    stops = stopData.s.map((row, id) => ({ id, name: row[0], lat: row[1], lon: row[2], key: row[3] }));

    stopByName.clear();
    stopsList.innerHTML = '';
    for (const stop of stops) {
      const key = normalize(stop.name);
      if (!stopByName.has(key)) stopByName.set(key, stop.id);
      const option = document.createElement('option');
      option.value = stop.name;
      stopsList.append(option);
    }

    if (manifest.dates?.length) {
      dateInput.min = manifest.dates[0];
      dateInput.max = manifest.dates.at(-1);
      if (!manifest.dates.includes(dateInput.value)) dateInput.value = manifest.dates[0];
    }

    dataInfo.textContent = manifest.generated ? `Data vytvořena ${manifest.generated}` : '';
    setStatus(`Připraveno · ${stops.length.toLocaleString('cs-CZ')} zastávek/uzlů`);
  } catch (err) {
    console.error(err);
    setStatus('Datová část ještě není vygenerovaná. Spusť nejprve npm run build-data.', true);
  }
}

async function loadDay(date) {
  if (dayCache.has(date)) return dayCache.get(date);
  if (!manifest?.dates?.includes(date)) throw new Error('Pro vybrané datum nemáme jízdní řád.');
  setStatus(`Načítám jízdní řád pro ${date}…`);
  const data = await loadJsonGzip(`${DATA_DIR}/${date}.json.gz`);
  dayCache.set(date, data);
  return data;
}

function resolveStop(input) {
  const exact = stopByName.get(normalize(input.value));
  return Number.isInteger(exact) ? exact : null;
}

function routeMode(routeType) {
  const t = Number(routeType);
  if (t === 0 || (t >= 900 && t < 1000)) return '🚋';
  if (t === 1 || (t >= 400 && t < 500)) return '🚇';
  if (t === 2 || (t >= 100 && t < 200)) return '🚆';
  if (t === 4 || (t >= 1000 && t < 1100)) return '⛴️';
  if (t === 7 || (t >= 1300 && t < 1400)) return '🚞';
  if (t === 11 || (t >= 800 && t < 900)) return '🚎';
  return '🚌';
}

function findJourneys(day, origin, destination, departAt) {
  const trips = day.t;
  const routes = day.r;
  const N = stops.length;
  const INF = 1e9;
  const rounds = [];
  const preds = [];

  let prev = new Int32Array(N);
  prev.fill(INF);
  prev[origin] = departAt;
  rounds.push(prev);
  preds.push(new Array(N));

  for (let round = 1; round <= MAX_LEGS; round++) {
    const curr = new Int32Array(N);
    curr.fill(INF);
    const pred = new Array(N);
    const penalty = round === 1 ? 0 : TRANSFER_MINUTES;

    for (let tripIndex = 0; tripIndex < trips.length; tripIndex++) {
      const trip = trips[tripIndex];
      const seq = trip[3];
      let boarded = false;
      let boardIndex = -1;
      let boardStop = -1;

      for (let i = 0; i < seq.length; i++) {
        const row = seq[i];
        const stopId = row[0];
        const arr = row[1];
        const dep = row[2];
        const pickup = row[3];
        const dropoff = row[4];

        if (!boarded && pickup !== 1 && prev[stopId] < INF && prev[stopId] + penalty <= dep) {
          boarded = true;
          boardIndex = i;
          boardStop = stopId;
        }

        if (boarded && i > boardIndex && dropoff !== 1 && arr < curr[stopId]) {
          curr[stopId] = arr;
          pred[stopId] = {
            prevStop: boardStop,
            tripIndex,
            boardIndex,
            alightIndex: i,
            prevRound: round - 1
          };
        }
      }
    }

    rounds.push(curr);
    preds.push(pred);
  }

  const candidates = [];
  for (let r = 1; r <= MAX_LEGS; r++) {
    if (rounds[r][destination] >= INF) continue;
    const legs = [];
    let stopId = destination;
    let rr = r;
    let ok = true;

    while (rr > 0 && stopId !== origin) {
      const p = preds[rr][stopId];
      if (!p) { ok = false; break; }
      const trip = trips[p.tripIndex];
      const route = routes[trip[0]];
      const seq = trip[3];
      const b = seq[p.boardIndex];
      const a = seq[p.alightIndex];
      legs.unshift({
        route: route[1],
        routeType: route[2],
        headsign: trip[1],
        tripShort: trip[2],
        from: b[0],
        to: a[0],
        dep: b[2],
        arr: a[1]
      });
      stopId = p.prevStop;
      rr = p.prevRound;
    }

    if (!ok || stopId !== origin || !legs.length) continue;
    const signature = legs.map(l => `${l.route}:${l.from}-${l.to}`).join('|');
    candidates.push({
      signature,
      legs,
      dep: legs[0].dep,
      arr: legs.at(-1).arr,
      duration: legs.at(-1).arr - legs[0].dep,
      transfers: legs.length - 1
    });
  }

  const seen = new Set();
  return candidates
    .sort((a, b) => a.arr - b.arr || a.transfers - b.transfers || a.dep - b.dep)
    .filter(j => !seen.has(j.signature) && seen.add(j.signature))
    .slice(0, 4);
}

function renderJourneys(journeys) {
  resultsEl.innerHTML = '';
  if (!journeys.length) {
    resultsEl.innerHTML = '<div class="empty">Pro zadaný čas jsem nenašel použitelné spojení. Zkus jiný čas nebo zkontroluj názvy zastávek.</div>';
    return;
  }

  for (const j of journeys) {
    const card = document.createElement('article');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-summary">
        <div class="result-time">${formatTime(j.dep)} → ${formatTime(j.arr)}</div>
        <div class="result-duration">${formatDuration(j.duration)}</div>
        <div class="result-transfers">${j.transfers === 0 ? 'bez přestupu' : `${j.transfers} ${j.transfers === 1 ? 'přestup' : 'přestupy'}`}</div>
      </div>
      <div class="legs"></div>`;
    const legsEl = card.querySelector('.legs');

    j.legs.forEach((leg, idx) => {
      if (idx > 0) {
        const prev = j.legs[idx - 1];
        const transfer = document.createElement('div');
        transfer.className = 'transfer-note';
        transfer.textContent = `Přestup · ${formatDuration(leg.dep - prev.arr)}`;
        legsEl.append(transfer);
      }
      const el = document.createElement('div');
      el.className = 'leg';
      el.innerHTML = `
        <div class="mode-icon" aria-hidden="true">${routeMode(leg.routeType)}</div>
        <div class="line-badge">${escapeHtml(leg.route || '?')}</div>
        <div class="leg-main">
          <div class="leg-head"><strong>směr ${escapeHtml(leg.headsign || '')}</strong>${leg.tripShort ? `<span class="direction">spoj ${escapeHtml(leg.tripShort)}</span>` : ''}</div>
          <div class="stop-row"><time>${formatTime(leg.dep)}</time><span>${escapeHtml(stops[leg.from]?.name || '')}</span></div>
          <div class="stop-row"><time>${formatTime(leg.arr)}</time><span>${escapeHtml(stops[leg.to]?.name || '')}</span></div>
        </div>`;
      legsEl.append(el);
    });
    resultsEl.append(card);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

async function search() {
  const origin = resolveStop(fromInput);
  const destination = resolveStop(toInput);
  if (origin == null || destination == null) {
    setStatus('Vyber obě zastávky přesně ze seznamu.', true);
    return;
  }
  if (origin === destination) {
    setStatus('Výchozí a cílová zastávka jsou stejné.', true);
    return;
  }
  if (!dateInput.value || !timeInput.value) {
    setStatus('Vyber datum a čas odjezdu.', true);
    return;
  }

  searchBtn.disabled = true;
  try {
    const day = await loadDay(dateInput.value);
    setStatus('Hledám nejlepší spojení…');
    await new Promise(requestAnimationFrame);
    const journeys = findJourneys(day, origin, destination, timeToMinutes(timeInput.value));
    renderJourneys(journeys);
    setStatus(journeys.length ? `Nalezeno ${journeys.length} variant.` : 'Spojení nenalezeno.');
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Nepodařilo se načíst jízdní řád.', true);
  } finally {
    searchBtn.disabled = false;
  }
}

swapBtn.addEventListener('click', () => {
  [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
});
searchBtn.addEventListener('click', search);
[fromInput, toInput, dateInput, timeInput].forEach(el => el.addEventListener('keydown', e => {
  if (e.key === 'Enter') search();
}));

init();
