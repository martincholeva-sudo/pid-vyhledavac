import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

const gzip = promisify(zlib.gzip);
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_URL = 'https://data.pid.cz/PID_GTFS.zip';
const SOURCE = process.env.GTFS_SOURCE || DEFAULT_URL;
const DAYS = Number(process.env.DAYS || 15);

const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
const gtfsDate = iso => iso.replaceAll('-', '');

function parseTime(v) {
  if (!v) return null;
  const [h, m, s = '0'] = v.split(':').map(Number);
  return h * 60 + m + (s >= 30 ? 1 : 0);
}

function readCsv(zip, name, required = true) {
  const entry = zip.getEntry(name);
  if (!entry) {
    if (required) throw new Error(`V GTFS chybí ${name}`);
    return [];
  }
  return parse(entry.getData(), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
}

async function getSourceBuffer(source) {
  if (/^https?:\/\//i.test(source)) {
    console.log(`Stahuji ${source}`);
    const response = await fetch(source, { headers: { 'user-agent': 'pid-vyhledavac/0.1' } });
    if (!response.ok) throw new Error(`GTFS download selhal: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  console.log(`Čtu lokální GTFS ${source}`);
  return fs.readFile(source);
}

function activeServicesForDate(dateIso, calendar, exceptions) {
  const ymd = gtfsDate(dateIso);
  const d = new Date(`${dateIso}T12:00:00Z`);
  const weekday = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][d.getUTCDay()];
  const active = new Set();

  for (const c of calendar) {
    if (c.start_date <= ymd && c.end_date >= ymd && c[weekday] === '1') active.add(c.service_id);
  }
  for (const x of exceptions) {
    if (x.date !== ymd) continue;
    if (x.exception_type === '1') active.add(x.service_id);
    if (x.exception_type === '2') active.delete(x.service_id);
  }
  return active;
}

await fs.mkdir(DATA_DIR, { recursive: true });
const buf = await getSourceBuffer(SOURCE);
console.log(`GTFS ZIP: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
const zip = new AdmZip(buf);

console.log('Čtu GTFS tabulky…');
const stopsRaw = readCsv(zip, 'stops.txt');
const routesRaw = readCsv(zip, 'routes.txt');
const tripsRaw = readCsv(zip, 'trips.txt');
const stopTimesRaw = readCsv(zip, 'stop_times.txt');
const calendarRaw = readCsv(zip, 'calendar.txt', false);
const calendarDatesRaw = readCsv(zip, 'calendar_dates.txt', false);

// Seskupíme jednotlivé sloupky/nástupiště do jednoho přestupního uzlu.
const groupKeyForStop = s => {
  if (s.asw_node_id) return `N:${s.asw_node_id}`;
  if (s.parent_station) return `P:${s.parent_station}`;
  return `S:${s.stop_name}|${Number(s.stop_lat || 0).toFixed(4)}|${Number(s.stop_lon || 0).toFixed(4)}`;
};

const groupMap = new Map();
for (const s of stopsRaw) {
  if (s.location_type && !['0','1'].includes(s.location_type)) continue;
  const key = groupKeyForStop(s);
  if (!groupMap.has(key)) groupMap.set(key, { key, names: new Map(), lat: 0, lon: 0, count: 0, stopIds: [] });
  const g = groupMap.get(key);
  g.names.set(s.stop_name, (g.names.get(s.stop_name) || 0) + 1);
  if (Number.isFinite(Number(s.stop_lat)) && Number.isFinite(Number(s.stop_lon))) {
    g.lat += Number(s.stop_lat); g.lon += Number(s.stop_lon); g.count++;
  }
  g.stopIds.push(s.stop_id);
}

const groups = [...groupMap.values()].sort((a,b) => {
  const an = [...a.names.keys()][0] || '';
  const bn = [...b.names.keys()][0] || '';
  return an.localeCompare(bn, 'cs');
});
const groupId = new Map(groups.map((g, i) => [g.key, i]));
const stopIdToGroup = new Map();
for (const s of stopsRaw) {
  const gid = groupId.get(groupKeyForStop(s));
  if (gid != null) stopIdToGroup.set(s.stop_id, gid);
}

const stopsOut = groups.map(g => {
  const name = [...g.names.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] || 'Neznámá zastávka';
  return [name, g.count ? +(g.lat/g.count).toFixed(6) : 0, g.count ? +(g.lon/g.count).toFixed(6) : 0, g.key];
});
await fs.writeFile(path.join(DATA_DIR, 'stops.json'), JSON.stringify({ s: stopsOut }));

const routeById = new Map(routesRaw.map(r => [r.route_id, r]));
const tripById = new Map(tripsRaw.map(t => [t.trip_id, t]));
const stopTimesByTrip = new Map();
for (const st of stopTimesRaw) {
  const gid = stopIdToGroup.get(st.stop_id);
  if (gid == null) continue;
  if (!stopTimesByTrip.has(st.trip_id)) stopTimesByTrip.set(st.trip_id, []);
  stopTimesByTrip.get(st.trip_id).push(st);
}
for (const arr of stopTimesByTrip.values()) arr.sort((a,b) => Number(a.stop_sequence)-Number(b.stop_sequence));

const now = new Date();
const dates = [];
for (let i = 0; i < DAYS; i++) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
  dates.push(fmtDate(d));
}

for (const dateIso of dates) {
  console.log(`Zpracovávám ${dateIso}…`);
  const active = activeServicesForDate(dateIso, calendarRaw, calendarDatesRaw);
  const dateObj = new Date(`${dateIso}T12:00:00Z`);
  dateObj.setUTCDate(dateObj.getUTCDate() - 1);
  const previousIso = fmtDate(dateObj);
  const activePrevious = activeServicesForDate(previousIso, calendarRaw, calendarDatesRaw);

  // K aktuálnímu provoznímu dni přidáme i noční spoje předchozího dne,
  // jejichž GTFS časy pokračují přes 24:00. Časy posuneme o -24 h.
  const tripCandidates = [];
  for (const t of tripsRaw) {
    if (active.has(t.service_id)) tripCandidates.push([t, 0]);
    if (activePrevious.has(t.service_id)) {
      const rawSeq = stopTimesByTrip.get(t.trip_id);
      if (rawSeq?.some(st => (parseTime(st.arrival_time) ?? parseTime(st.departure_time) ?? -1) >= 1440)) {
        tripCandidates.push([t, -1440]);
      }
    }
  }

  const usedRouteIds = [...new Set(tripCandidates.map(([t]) => t.route_id).filter(id => routeById.has(id)))];
  usedRouteIds.sort();
  const routeIndex = new Map(usedRouteIds.map((id, i) => [id, i]));
  const routesOut = usedRouteIds.map(id => {
    const r = routeById.get(id);
    return [id, r.route_short_name || r.route_long_name || id, Number(r.route_type || 3), r.route_color || '', r.route_text_color || ''];
  });

  const tripsOut = [];
  for (const [t, timeShift] of tripCandidates) {
    const rawSeq = stopTimesByTrip.get(t.trip_id);
    if (!rawSeq || rawSeq.length < 2) continue;
    const seq = [];
    let lastGroup = null;
    for (const st of rawSeq) {
      const gid = stopIdToGroup.get(st.stop_id);
      if (gid == null) continue;
      let arr = parseTime(st.arrival_time);
      let dep = parseTime(st.departure_time);
      if (arr == null || dep == null) continue;
      arr += timeShift;
      dep += timeShift;
      const row = [gid, arr, dep, Number(st.pickup_type || 0), Number(st.drop_off_type || 0)];
      if (gid === lastGroup && seq.length) {
        // Sloučí virtuální záznamy stejného uzlu, pokud se ve feedu objeví za sebou.
        seq[seq.length - 1][1] = Math.min(seq[seq.length - 1][1], arr);
        seq[seq.length - 1][2] = Math.max(seq[seq.length - 1][2], dep);
      } else {
        seq.push(row);
        lastGroup = gid;
      }
    }
    if (seq.length < 2) continue;
    tripsOut.push([
      routeIndex.get(t.route_id),
      t.trip_headsign || '',
      t.trip_short_name || '',
      seq
    ]);
  }

  // Řadíme podle prvního odjezdu; vyhledávač pak může později ještě lépe optimalizovat scan.
  tripsOut.sort((a,b) => a[3][0][2] - b[3][0][2]);
  const json = Buffer.from(JSON.stringify({ r: routesOut, t: tripsOut }));
  const gz = await gzip(json, { level: 9 });
  await fs.writeFile(path.join(DATA_DIR, `${dateIso}.json.gz`), gz);
  console.log(`  ${tripsOut.length} spojů · JSON ${(json.length/1024/1024).toFixed(1)} MB · gzip ${(gz.length/1024/1024).toFixed(1)} MB`);
}

const manifest = {
  generated: new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }).format(new Date()),
  source: DEFAULT_URL,
  dates
};
await fs.writeFile(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Hotovo.');
