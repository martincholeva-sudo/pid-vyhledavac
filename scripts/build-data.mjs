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

const fmtDate = d =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

const gtfsDate = iso => iso.replaceAll('-', '');

function parseTime(v) {
  if (!v) return null;

  const [h, m, s = '0'] = v.split(':').map(Number);

  return h * 60 + m + (s >= 30 ? 1 : 0);
}

function normalizeName(v = '') {
  return String(v)
    .trim()
    .toLocaleLowerCase('cs-CZ')
    .replace(/\s+/g, ' ');
}

function readCsv(zip, name, required = true) {
  const entry = zip.getEntry(name);

  if (!entry) {
    if (required) {
      throw new Error(`V GTFS chybí ${name}`);
    }

    return [];
  }

  return parse(entry.getData(), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true
  });
}

async function getSourceBuffer(source) {
  if (/^https?:\/\//i.test(source)) {
    console.log(`Stahuji ${source}`);

    const response = await fetch(source, {
      headers: {
        'user-agent': 'pid-vyhledavac/0.2'
      }
    });

    if (!response.ok) {
      throw new Error(
        `GTFS download selhal: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  console.log(`Čtu lokální GTFS ${source}`);

  return fs.readFile(source);
}

function activeServicesForDate(
  dateIso,
  calendar,
  exceptions
) {
  const ymd = gtfsDate(dateIso);

  const d = new Date(
    `${dateIso}T12:00:00Z`
  );

  const weekday = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday'
  ][d.getUTCDay()];

  const active = new Set();

  for (const c of calendar) {
    if (
      c.start_date <= ymd &&
      c.end_date >= ymd &&
      c[weekday] === '1'
    ) {
      active.add(c.service_id);
    }
  }

  for (const x of exceptions) {
    if (x.date !== ymd) {
      continue;
    }

    if (x.exception_type === '1') {
      active.add(x.service_id);
    }

    if (x.exception_type === '2') {
      active.delete(x.service_id);
    }
  }

  return active;
}

function groupKeyForStop(s) {
  const name = normalizeName(
    s.stop_name
  );

  /*
   * Jeden PID uzel může obsahovat několik
   * různě pojmenovaných zastávek.
   *
   * Proto nestačí seskupovat pouze podle
   * asw_node_id.
   *
   * Použijeme:
   *
   * ASW uzel + název zastávky
   */

  if (s.asw_node_id) {
    return (
      `N:${s.asw_node_id}|${name}`
    );
  }

  /*
   * Pokud ASW uzel není vyplněný,
   * použijeme parent_station.
   *
   * To je důležité například u některých
   * nástupišť metra.
   */

  if (s.parent_station) {
    return (
      `P:${s.parent_station}|${name}`
    );
  }

  /*
   * Nouzová varianta pro samostatné
   * zastávky.
   *
   * Přidáváme GPS, aby se nespojily
   * stejně pojmenované zastávky
   * v různých obcích.
   */

  const lat =
    Number(s.stop_lat || 0)
      .toFixed(4);

  const lon =
    Number(s.stop_lon || 0)
      .toFixed(4);

  return (
    `S:${name}|${lat}|${lon}`
  );
}

/*
 * =====================================================
 * STAŽENÍ DAT
 * =====================================================
 */

await fs.mkdir(
  DATA_DIR,
  {
    recursive: true
  }
);

const buf =
  await getSourceBuffer(
    SOURCE
  );

console.log(
  `GTFS ZIP: ${(
    buf.length /
    1024 /
    1024
  ).toFixed(1)} MB`
);

const zip =
  new AdmZip(buf);

console.log(
  'Čtu GTFS tabulky…'
);

const stopsRaw =
  readCsv(
    zip,
    'stops.txt'
  );

const routesRaw =
  readCsv(
    zip,
    'routes.txt'
  );

const tripsRaw =
  readCsv(
    zip,
    'trips.txt'
  );

const stopTimesRaw =
  readCsv(
    zip,
    'stop_times.txt'
  );

const calendarRaw =
  readCsv(
    zip,
    'calendar.txt',
    false
  );

const calendarDatesRaw =
  readCsv(
    zip,
    'calendar_dates.txt',
    false
  );

/*
 * =====================================================
 * SKUTEČNĚ OBSLUHOVANÉ ZASTÁVKY
 * =====================================================
 *
 * stops.txt obsahuje kromě zastávek také
 * například station / parent záznamy.
 *
 * Ty mohou mít stejný název jako skutečná
 * nástupiště, ale nejsou v stop_times.txt.
 *
 * Do našeho routeru proto pustíme jen
 * zastávky, na kterých nějaký spoj skutečně
 * jede.
 */

const servedStopIds =
  new Set(
    stopTimesRaw.map(
      st => st.stop_id
    )
  );

/*
 * =====================================================
 * PŘESTUPNÍ UZLY
 * =====================================================
 */

const groupMap =
  new Map();

for (const s of stopsRaw) {
  if (
    !servedStopIds.has(
      s.stop_id
    )
  ) {
    continue;
  }

  if (!s.stop_name) {
    continue;
  }

  const key =
    groupKeyForStop(s);

  if (
    !groupMap.has(key)
  ) {
    groupMap.set(
      key,
      {
        key,
        names: new Map(),
        lat: 0,
        lon: 0,
        count: 0,
        stopIds: []
      }
    );
  }

  const g =
    groupMap.get(key);

  g.names.set(
    s.stop_name,
    (
      g.names.get(
        s.stop_name
      ) || 0
    ) + 1
  );

  const lat =
    Number(
      s.stop_lat
    );

  const lon =
    Number(
      s.stop_lon
    );

  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon)
  ) {
    g.lat += lat;
    g.lon += lon;
    g.count++;
  }

  g.stopIds.push(
    s.stop_id
  );
}

/*
 * Stabilní pořadí zastávek.
 */

const groups =
  [...groupMap.values()]
    .sort(
      (a, b) => {
        const an =
          [...a.names.keys()][0] ||
          '';

        const bn =
          [...b.names.keys()][0] ||
          '';

        return (
          an.localeCompare(
            bn,
            'cs'
          ) ||
          a.key.localeCompare(
            b.key,
            'cs'
          )
        );
      }
    );

/*
 * Interní číselné ID uzlu.
 */

const groupId =
  new Map(
    groups.map(
      (g, i) => [
        g.key,
        i
      ]
    )
  );

/*
 * Převod GTFS stop_id -> náš uzel.
 */

const stopIdToGroup =
  new Map();

for (const s of stopsRaw) {
  if (
    !servedStopIds.has(
      s.stop_id
    )
  ) {
    continue;
  }

  if (!s.stop_name) {
    continue;
  }

  const gid =
    groupId.get(
      groupKeyForStop(s)
    );

  if (gid != null) {
    stopIdToGroup.set(
      s.stop_id,
      gid
    );
  }
}

/*
 * =====================================================
 * stops.json
 * =====================================================
 */

const stopsOut =
  groups.map(
    g => {
      const name =
        [...g.names.entries()]
          .sort(
            (a, b) =>
              b[1] -
                a[1] ||
              a[0].localeCompare(
                b[0],
                'cs'
              )
          )[0]?.[0] ||
        'Neznámá zastávka';

      return [
        name,

        g.count
          ? +(
              g.lat /
              g.count
            ).toFixed(6)
          : 0,

        g.count
          ? +(
              g.lon /
              g.count
            ).toFixed(6)
          : 0,

        g.key
      ];
    }
  );

await fs.writeFile(
  path.join(
    DATA_DIR,
    'stops.json'
  ),

  JSON.stringify({
    s: stopsOut
  })
);

console.log(
  `Přestupních uzlů: ${groups.length.toLocaleString(
    'cs-CZ'
  )}`
);

/*
 * =====================================================
 * LINKY
 * =====================================================
 */

const routeById =
  new Map(
    routesRaw.map(
      r => [
        r.route_id,
        r
      ]
    )
  );

/*
 * =====================================================
 * STOP TIMES PODLE SPOJE
 * =====================================================
 */

const stopTimesByTrip =
  new Map();

for (
  const st of
  stopTimesRaw
) {
  const gid =
    stopIdToGroup.get(
      st.stop_id
    );

  if (gid == null) {
    continue;
  }

  if (
    !stopTimesByTrip.has(
      st.trip_id
    )
  ) {
    stopTimesByTrip.set(
      st.trip_id,
      []
    );
  }

  stopTimesByTrip
    .get(st.trip_id)
    .push(st);
}

for (
  const arr of
  stopTimesByTrip.values()
) {
  arr.sort(
    (a, b) =>
      Number(
        a.stop_sequence
      ) -
      Number(
        b.stop_sequence
      )
  );
}

/*
 * =====================================================
 * DATUMY
 * =====================================================
 */

const now =
  new Date();

const dates = [];

for (
  let i = 0;
  i < DAYS;
  i++
) {
  const d =
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + i
      )
    );

  dates.push(
    fmtDate(d)
  );
}

/*
 * =====================================================
 * JEDNOTLIVÉ DNY
 * =====================================================
 */

for (
  const dateIso of
  dates
) {
  console.log(
    `Zpracovávám ${dateIso}…`
  );

  const active =
    activeServicesForDate(
      dateIso,
      calendarRaw,
      calendarDatesRaw
    );

  /*
   * Předchozí provozní den.
   */

  const dateObj =
    new Date(
      `${dateIso}T12:00:00Z`
    );

  dateObj.setUTCDate(
    dateObj.getUTCDate() -
      1
  );

  const previousIso =
    fmtDate(dateObj);

  const activePrevious =
    activeServicesForDate(
      previousIso,
      calendarRaw,
      calendarDatesRaw
    );

  /*
   * ===================================================
   * SPOJE PRO DANÝ DEN
   * ===================================================
   */

  const tripCandidates =
    [];

  for (
    const t of tripsRaw
  ) {
    /*
     * Normální spoje daného dne.
     */

    if (
      active.has(
        t.service_id
      )
    ) {
      tripCandidates.push(
        [
          t,
          0
        ]
      );
    }

    /*
     * Noční spoje předchozího dne.
     *
     * GTFS používá například 25:10.
     */

    if (
      activePrevious.has(
        t.service_id
      )
    ) {
      const rawSeq =
        stopTimesByTrip.get(
          t.trip_id
        );

      const goesPastMidnight =
        rawSeq?.some(
          st =>
            (
              parseTime(
                st.arrival_time
              ) ??
              parseTime(
                st.departure_time
              ) ??
              -1
            ) >= 1440
        );

      if (
        goesPastMidnight
      ) {
        tripCandidates.push(
          [
            t,
            -1440
          ]
        );
      }
    }
  }

  /*
   * ===================================================
   * POUŽITÉ LINKY
   * ===================================================
   */

  const usedRouteIds =
    [
      ...new Set(
        tripCandidates
          .map(
            ([t]) =>
              t.route_id
          )
          .filter(
            id =>
              routeById.has(id)
          )
      )
    ].sort();

  const routeIndex =
    new Map(
      usedRouteIds.map(
        (id, i) => [
          id,
          i
        ]
      )
    );

  const routesOut =
    usedRouteIds.map(
      id => {
        const r =
          routeById.get(id);

        return [
          id,

          r.route_short_name ||
            r.route_long_name ||
            id,

          Number(
            r.route_type ||
              3
          ),

          r.route_color ||
            '',

          r.route_text_color ||
            ''
        ];
      }
    );

  /*
   * ===================================================
   * SPOJE
   * ===================================================
   */

  const tripsOut =
    [];

  for (
    const [
      t,
      timeShift
    ] of
    tripCandidates
  ) {
    const rawSeq =
      stopTimesByTrip.get(
        t.trip_id
      );

    if (
      !rawSeq ||
      rawSeq.length < 2
    ) {
      continue;
    }

    const seq = [];

    let lastGroup =
      null;

    for (
      const st of rawSeq
    ) {
      const gid =
        stopIdToGroup.get(
          st.stop_id
        );

      if (
        gid == null
      ) {
        continue;
      }

      let arr =
        parseTime(
          st.arrival_time
        );

      let dep =
        parseTime(
          st.departure_time
        );

      if (
        arr == null ||
        dep == null
      ) {
        continue;
      }

      arr +=
        timeShift;

      dep +=
        timeShift;

      const row = [
        gid,
        arr,
        dep,

        Number(
          st.pickup_type ||
            0
        ),

        Number(
          st.drop_off_type ||
            0
        )
      ];

      /*
       * Pokud má GTFS několik virtuálních
       * variant stejného fyzického místa
       * hned za sebou, spojíme je.
       */

      if (
        gid ===
          lastGroup &&
        seq.length
      ) {
        seq[
          seq.length - 1
        ][1] =
          Math.min(
            seq[
              seq.length -
                1
            ][1],
            arr
          );

        seq[
          seq.length - 1
        ][2] =
          Math.max(
            seq[
              seq.length -
                1
            ][2],
            dep
          );
      } else {
        seq.push(row);

        lastGroup =
          gid;
      }
    }

    if (
      seq.length < 2
    ) {
      continue;
    }

    tripsOut.push(
      [
        routeIndex.get(
          t.route_id
        ),

        t.trip_headsign ||
          '',

        t.trip_short_name ||
          '',

        seq
      ]
    );
  }

  /*
   * Řadíme podle prvního odjezdu.
   */

  tripsOut.sort(
    (a, b) =>
      a[3][0][2] -
      b[3][0][2]
  );

  /*
   * ===================================================
   * ULOŽENÍ DNE
   * ===================================================
   */

  const json =
    Buffer.from(
      JSON.stringify({
        r: routesOut,
        t: tripsOut
      })
    );

  const gz =
    await gzip(
      json,
      {
        level: 9
      }
    );

  await fs.writeFile(
    path.join(
      DATA_DIR,
      `${dateIso}.json.gz`
    ),

    gz
  );

  console.log(
    `  ${tripsOut.length.toLocaleString(
      'cs-CZ'
    )} spojů · ` +
      `JSON ${(
        json.length /
        1024 /
        1024
      ).toFixed(
        1
      )} MB · ` +
      `gzip ${(
        gz.length /
        1024 /
        1024
      ).toFixed(
        1
      )} MB`
  );
}

/*
 * =====================================================
 * MANIFEST
 * =====================================================
 */

const manifest = {
  generated:
    new Intl.DateTimeFormat(
      'cs-CZ',
      {
        dateStyle:
          'medium',

        timeStyle:
          'short',

        timeZone:
          'Europe/Prague'
      }
    ).format(
      new Date()
    ),

  source:
    DEFAULT_URL,

  dates
};

await fs.writeFile(
  path.join(
    DATA_DIR,
    'manifest.json'
  ),

  JSON.stringify(
    manifest,
    null,
    2
  )
);

console.log(
  'Hotovo.'
);
