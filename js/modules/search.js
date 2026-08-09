// Labels
const TIME_BETWEEN_REQ_ACCEPTABLE = 300 // [ms]
let language = "it"

const LABELS = {
  en: {
    searching: 'Searching',
    noresult: 'No result',
    btnsearch: "Search",
    title: "Search Station"
  },
  it: {
    searching: 'Ricerca in corso',
    noresult: 'Nessun risultato',
    btnsearch: "Cerca",
    title: "Cerca Stazione"
  },
  fr: {
    searching: 'Recherche en cours',
    noresult: 'Pas de résultat',
    btnsearch: "Chercher",
    title: "Rechercher Gare"
  }
}

function getLabel(key) {
  const lang = LABELS[language] || LABELS['en']
  return lang[key]
}

function getLangFromURL() {
  return new URLSearchParams(window.location.search).get('lang')
}

// Events
document.addEventListener('DOMContentLoaded', () => {
  const paramLang = getLangFromURL()
  language = paramLang ? paramLang.toLowerCase() : navigator.language.split('-')[0]

  document.getElementById("btn-search").textContent = getLabel("btnsearch")
  document.getElementById("title").textContent = getLabel("title")
})

function debounce(fn, delay) {
  let timeout
  return function (...args) {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn.apply(this, args), delay)
  }
}

async function do_req_search(e) {
  e.preventDefault()
  const keyword = document.getElementById("searchInput").value.trim()
  if (!keyword) return

  const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/autocompletaStazione/${encodeURIComponent(keyword)}`
  const resultsDiv = document.getElementById("results")

  try {
    const text = await fetchViaProxy(url, { asJSON: false })
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

    if (!lines.length) {
      resultsDiv.innerHTML = `<div class="text-danger">${getLabel("noresult")}.</div>`
      return
    }

    resultsDiv.innerHTML = ""
    lines.forEach(line => {
      const [name, id] = line.split('|')
      if (!name || !id) return

      const link = document.createElement("a")
      link.href = `index.html?stationID=${id}&stationName=${encodeURIComponent(name)}`
      link.className = "list-group-item list-group-item-action"
      link.innerHTML = `
        <strong>${name}</strong>
        <small class="text-primary">(${id})</small>
      `
      resultsDiv.appendChild(link)
    })
  } catch (err) {
    resultsDiv.innerHTML = `<div class="text-danger">Fail during searching</div>`
    console.error(err)
  }
}

document.getElementById("searchForm").addEventListener("input", debounce(async e => {
  do_req_search(e)
}, TIME_BETWEEN_REQ_ACCEPTABLE))

document.getElementById("searchForm").addEventListener("submit", async e => { do_req_search(e) })
