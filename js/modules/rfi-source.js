// The official RFI station board (the one shown in the station). RFI serves an HTML page with no
// CORS headers, so it goes through the same relays as ViaggiaTreno and is parsed here.
const RFI_MONITOR = 'https://iechub.rfi.it/ArriviPartenze/ArrivalsDepartures/Monitor'

// ViaggiaTreno station code (S04533) -> RFI placeId (198). Resolves to {} when the file is unreachable.
async function loadRfiIds() {
  try {
    return await (await fetch('data/rfi-ids.json')).json()
  } catch {
    return {}
  }
}

function rfiMonitorUrl(placeId, arrivals) {
  return `${RFI_MONITOR}?placeId=${placeId}&arrivals=${arrivals ? 'True' : 'False'}`
}

const rfiCellText = (row, id) => (row.querySelector(`#${id}`)?.textContent || '').replace(/\s+/g, ' ').trim()

function parseRfiRows(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return [...doc.querySelectorAll('tr[name="treno"]')].map(row => {
    const stops = (row.querySelector('.testoinfoaggiuntive')?.textContent || '').replace(/\s+/g, ' ').trim()
    const delay = parseInt((rfiCellText(row, 'RRitardo').match(/\d+/) || [0])[0], 10)
    return {
      operator: row.querySelector('.logoCliente')?.getAttribute('alt') || '',
      category: (row.querySelector('.logoCategoria')?.getAttribute('alt') || '').replace(/^Categoria\s*/i, ''),
      number: rfiCellText(row, 'RTreno'),
      place: rfiCellText(row, 'RStazione'),
      time: rfiCellText(row, 'ROrario'),
      delay: Number.isFinite(delay) ? delay : 0,
      platform: rfiCellText(row, 'RBinario'),
      departing: !!row.querySelector('.exlampeggio'), // the blinking "in partenza / in arrivo" marker
      stops: stops.replace(/^FERMA A:\s*/i, '')
    }
  }).filter(r => r.number) // the page also carries empty filler rows
}

// Throws when the relays fail or the page is not the board.
async function fetchRfiRows(placeId, arrivals = false) {
  const html = await fetchViaProxy(rfiMonitorUrl(placeId, arrivals), { asJSON: false, html: true })
  const rows = parseRfiRows(html)
  if (!rows.length && !/<tbody/i.test(html)) throw new Error('unexpected page from RFI')
  return rows
}

// ---- the three views of a station: Mix (both sources merged), Viaggia, RFI ----
function sourceHref(source, stationID, stationName) {
  const params = new URLSearchParams({ stationID })
  if (stationName) params.set('stationName', stationName)
  if (source === 'mix') params.set('source', 'mix')
  return `${source === 'rfi' ? 'rfi.html' : 'index.html'}?${params}`
}

// Fills <nav id="sourceSwitch">: three links, the active one highlighted.
function initSourceSwitch(active, stationID, stationName) {
  const nav = document.getElementById('sourceSwitch')
  nav.querySelectorAll('a').forEach(a => {
    const source = a.dataset.source
    a.href = sourceHref(source, stationID, stationName)
    a.classList.toggle('is-active', source === active)
    if (source === active) a.setAttribute('aria-current', 'page')
  })
  nav.hidden = false
}
