const TIME_BETWEEN_REQ_ACCEPTABLE = 300 // ms

const LABELS = {
  noresult: 'No result',
  failed: 'Search failed, please try again',
  btnsearch: 'Search',
  title: 'Search Station'
}

function debounce(fn, delay) {
  let timeout
  return (...args) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay)
  }
}

function showResultsMessage(text, className) {
  const message = document.createElement('p')
  message.className = className
  message.textContent = text
  document.getElementById('results').replaceChildren(message)
}

// Search results are untrusted text: build nodes with textContent, never innerHTML.
function resultLink(name, id) {
  const link = document.createElement('a')
  link.className = 'result-item'
  link.href = `index.html?stationID=${encodeURIComponent(id)}&stationName=${encodeURIComponent(name)}`

  const nameEl = document.createElement('strong')
  nameEl.textContent = name
  const idEl = document.createElement('small')
  idEl.textContent = id
  link.append(nameEl, idEl)
  return link
}

let latestRequest = 0

async function doSearch(e) {
  e.preventDefault()
  const keyword = document.getElementById('searchInput').value.trim()
  if (!keyword) return

  const requestId = ++latestRequest
  const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/autocompletaStazione/${encodeURIComponent(keyword)}`

  try {
    const text = await fetchViaProxy(url, { asJSON: false })
    if (requestId !== latestRequest) return // a newer search superseded this one

    const stations = text
      .split('\n')
      .map(line => line.trim().split('|'))
      .filter(([name, id]) => name && id)

    if (!stations.length) {
      showResultsMessage(LABELS.noresult, 'result-error')
      return
    }
    document.getElementById('results').replaceChildren(...stations.map(([name, id]) => resultLink(name, id)))
  } catch (err) {
    if (requestId !== latestRequest) return
    console.error(err)
    showResultsMessage(LABELS.failed, 'result-error')
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-search').textContent = LABELS.btnsearch
  document.getElementById('title').textContent = LABELS.title

  const form = document.getElementById('searchForm')
  form.addEventListener('input', debounce(doSearch, TIME_BETWEEN_REQ_ACCEPTABLE))
  form.addEventListener('submit', doSearch)
})
