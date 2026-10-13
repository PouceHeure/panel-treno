#!/usr/bin/env python3
"""Builds data/stations.json: ViaggiaTreno station code -> [lat, lon, name].

One request per region (elencoStazioni/<code>). Run it from a machine that ViaggiaTreno lets through
(it answers 403 to plain scripts, hence the browser-like headers):  python3 scripts/build-stations.py
"""
import json
import time
import urllib.request

BASE = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/elencoStazioni/'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'it-IT,it;q=0.9',
    'Referer': 'http://www.viaggiatreno.it/infomobilita/index.jsp',
}

stations = {}
for region in range(0, 23):
    try:
        req = urllib.request.Request(BASE + str(region), headers=HEADERS)
        rows = json.load(urllib.request.urlopen(req, timeout=30))
    except Exception as err:  # a region that does not exist answers with an error or an empty list
        print(region, 'skipped:', err)
        continue
    for row in rows:
        loc = row.get('localita') or {}
        lat, lon = row.get('lat'), row.get('lon')
        if row.get('codiceStazione') and lat and lon:
            stations[row['codiceStazione']] = [round(lat, 5), round(lon, 5), loc.get('nomeLungo', '')]
    print(region, len(rows), 'stations')
    time.sleep(1.5)

with open('data/stations.json', 'w') as f:
    json.dump(stations, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
print(len(stations), 'stations written')
