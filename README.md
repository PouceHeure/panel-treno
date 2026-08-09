# Panel Treno

Same idea as [Panel Bus](../bus-tic), but for Italian train stations: a single static page
showing the next departures for a station, refreshed automatically.

## Station ID

The app uses a ViaggiaTreno station code (e.g. `S01700` for Milano Centrale).

### Automatic Solution: Search Page

Use `search.html` to find a station by name and get a direct link.

### Manual Solution

```html
# generic
<URL>/?stationID=<ID>&stationName=<Name>
# change language (default = your navigator system language)
<URL>/?stationID=<ID>&lang={it,en,fr}
# hide the search/legend bar
<URL>/?stationID=<ID>&hidebar=true
```

- default ID: `S01700` (Milano Centrale)
- find an ID: use `search.html`, or look it up on
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
