# Panel Treno

Same idea as [Panel Bus](../bus-tic), but for Italian train stations: a single static page
showing the next departures for a station, refreshed automatically.

## Station ID

The app uses a ViaggiaTreno station code (e.g. `S01700` for Milano Centrale).

### Automatic Solution: Search Page

Use `home.html` to find a station by name and get a direct link.

### Manual Solution

```html
# generic
<URL>/?stationID=<ID>&stationName=<Name>
# hide the search/legend bar
<URL>/?stationID=<ID>&hidebar=true
# how departures are grouped, and an optional filter applied after grouping
<URL>/?stationID=<ID>&groupby={platform,destination,category,train}&groupfilter=<text>
```

- default ID: `S01700` (Milano Centrale)
- find an ID: use `home.html`, or look it up on
  [ViaggiaTreno](http://www.viaggiatreno.it)'s `autocompletaStazione` endpoint.

## Station Example List

- Milano Centrale: `?stationID=S01700`
- Roma Termini: `?stationID=S08409`

## Data

Data source: [ViaggiaTreno (RFI)](http://www.viaggiatreno.it), an unofficial public endpoint
used by Trenitalia's own real-time info systems.

It is HTTP-only and has no CORS headers, so this static HTTPS site cannot call it directly
(mixed content + CORS). Requests are relayed through public CORS proxies
(`js/modules/proxy.js`). This is a pragmatic choice to keep the project a simple static
site like Panel Bus, but it means reliability depends on those third-party proxies — if
departures stop loading, that's the most likely cause.

## Pages

| Page | What it is for |
| --- | --- |
| `home.html` | Find a station or a train. Search is local and instant (`data/stations.json`), favourite stations are starred, one train can be followed and shows its estimated arrival. |
| `index.html?stationID=…` | Departures board of a station, with direction chips and a star. |
| `index.html?view=train&train=…` | A train, in three tabs (`&tab=now|route|charts`): **Now** (arrival at the terminus, countdown to the next stop), **Route** (every stop, details) and **Charts** (the data behind the estimate). |
| `index.html?stationID=…&view=map` | The station map: the platforms of the station drawn from OpenStreetMap, with the next trains on them. |
| `rfi.html` | The official RFI station board. |
| `lab.html` | The data collected, the delay models, and how each scored on a day it never saw. |

Favourites, the followed train, recent searches and the device-side prediction log live in `localStorage`; nothing is sent anywhere.

## Delay models

`js/modules/model.js` holds the models, `js/modules/models.js` the registry (what exists, what each one needs). Times can be shown `raw` (the announced delay held on every stop) or `model` (recovery rules); the footer switch and `?times=raw` choose.

A model is only recommended when it beats `raw` on a day it was not fitted on. To refresh that verdict after collecting more data:

```bash
python3 scripts/evaluate.py path/to/export.json   # writes data/model-report.json
```

The script scores the models on the last day of the export and calibrates on the days before it; it reads the model constants from `model.js`, so it always scores what the app runs. It also says whether recalibrating would help.

`scripts/build-stations.py` rebuilds `data/stations.json` (station coordinates).

## Cache

Browsers keep a file until its address changes, so every page references its scripts and stylesheets with a hash of their content (`css/style.css?v=f1ddba43`). After editing any file in `js/` or `css/`, run:

```bash
python3 scripts/stamp-assets.py
```

The tests fail when a page is out of date.

## Tests

```bash
node --test tests/*.test.js                          # search, favourites, registry, prediction log
python3 -m unittest discover -s tests -p "test_*.py" # evaluation: pairs, chronological split, models
```

## Station map

`view=map` on a station draws its platforms and tracks from OpenStreetMap and puts the next trains (3 hours, up to 3 per platform) on their platform. Tracks are not numbered in OpenStreetMap, platforms are (`12;13` is an island serving tracks 12 and 13). The tracks are numbered from the platforms: the rail on each side of a platform is one of the tracks it serves, and the numbers grow across the station in one direction (found from the platforms themselves). A track is only numbered when its rail is not claimed by another number, so a train is never put on a wrong track; a train whose track was not found sits on its platform instead. ViaggiaTreno's platform (`binario`) is the track number.

The layout comes from `data/topology/<station code>.json` when the file exists, else from this browser's cache, else from a live Overpass query (slow: up to half a minute, and rate limited). To ship a station with the app:

```bash
python3 scripts/fetch-topology.py S04700 S01700   # station codes, as in data/stations.json
```

`js/modules/station-topology.js` holds the geometry (parsing, rotating the tracks level, fitting the canvas, matching a ViaggiaTreno platform label such as `1 Ovest` to a drawn platform); `js/modules/station-map.js` loads the layout and draws it. Map data (c) OpenStreetMap contributors, ODbL.
