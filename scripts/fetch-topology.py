#!/usr/bin/env python3
"""Downloads the track layout of stations from OpenStreetMap (Overpass) into data/topology/<station code>.json.

    python3 scripts/fetch-topology.py S04700 S01700 ...

Only what the station map needs is kept: platform and rail ways with their geometry and a few tags. The app
reads these files first; for a station without one it asks Overpass itself (slower, and rate limited), which
is why the main stations are fetched here once.
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
KEEP_TAGS = ('railway', 'public_transport', 'ref', 'local_ref', 'name', 'layer', 'tunnel', 'bridge', 'service', 'usage', 'level', 'train', 'subway', 'tram', 'light_rail', 'bus', 'highway')


def query(lat, lon, radius):
    around = f'(around:{radius},{lat},{lon})'
    return f'''[out:json][timeout:60];
(
  way{around}[railway=platform];
  way{around}[public_transport=platform][railway];
  way{around}[railway=rail];
);
out geom tags;'''


def trim(elements):
    out = []
    for e in elements:
        if e.get('type') != 'way' or not e.get('geometry'):
            continue
        out.append({
            'id': e['id'],
            'tags': {k: v for k, v in e.get('tags', {}).items() if k in KEEP_TAGS},
            'pts': [[round(p['lat'], 6), round(p['lon'], 6)] for p in e['geometry']],
        })
    return out


def fetch(lat, lon, radius):
    data = urllib.parse.urlencode({'data': query(lat, lon, radius)}).encode()
    last = None
    for attempt in range(3):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=data, headers={'User-Agent': 'panel-treno/1.0 (personal project, one request per station)'})
                return json.load(urllib.request.urlopen(req, timeout=90))['elements']
            except Exception as err:  # a busy or rate limited server: wait and try the next one
                last = err
                time.sleep(8)
    raise RuntimeError(f'Overpass unavailable: {last}')


def main(codes):
    stations = json.loads((ROOT / 'data' / 'stations.json').read_text())
    for code in codes:
        if code not in stations:
            print(code, 'unknown station code')
            continue
        lat, lon, name = stations[code]
        radius = 450 if name.upper() in ('MILANO CENTRALE', 'ROMA TERMINI', 'TORINO PORTA NUOVA') else 320
        ways = trim(fetch(lat, lon, radius))
        platforms = sum(1 for w in ways if w['tags'].get('railway') == 'platform' or w['tags'].get('public_transport') == 'platform')
        out = {'station': code, 'name': name, 'center': [lat, lon], 'radius': radius, 'ways': ways, 'source': 'OpenStreetMap contributors (ODbL)'}
        (ROOT / 'data' / 'topology' / f'{code}.json').write_text(json.dumps(out, separators=(',', ':')))
        print(f'{code} {name}: {len(ways)} ways, {platforms} platforms')
        time.sleep(6)


if __name__ == '__main__':
    main(sys.argv[1:])
