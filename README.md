# PID vyhledávač spojení – MVP

Statická webová aplikace pro vyhledávání spojení v PID nad oficiálním GTFS feedem.

## Co umí první verze

- vyhledat zastávku odkud / kam
- zvolit datum a čas odjezdu
- přímé spojení i spojení až se 3 přestupy
- metro, tramvaje, autobusy, trolejbusy, vlaky, přívozy a lanovku podle `route_type`
- denní automatickou aktualizaci GTFS přes GitHub Actions
- komprimovaná denní data (`.json.gz`) vhodná pro statický hosting

## První spuštění

```bash
npm install
npm run build-data
npm run serve
```

Potom otevři adresu, kterou vypíše lokální server. `index.html` neotvírej přímo přes `file://`, protože prohlížeč blokuje načítání dat přes `fetch`.

## Test s lokálním GTFS ZIPem

```bash
GTFS_SOURCE=/cesta/PID_GTFS.zip npm run build-data
```

## Publikace

Projekt je čisté HTML/CSS/JS. Lze ho publikovat jako statický web. GitHub Action jednou denně stáhne `https://data.pid.cz/PID_GTFS.zip`, vytvoří nové datové soubory a commitne je do repozitáře.

## Omezení MVP

- Přestupní čas je zatím jednotně 2 minuty.
- Neřeší pěší přestupy mezi různě pojmenovanými blízkými zastávkami.
- Nezapočítává zatím GTFS Realtime zpoždění ani mimořádnosti.
- Neoptimalizuje tarif/cenu.

To jsou další fáze projektu.
