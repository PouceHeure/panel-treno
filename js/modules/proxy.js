// =======================
// CORS Proxy Helper
// =======================
// ViaggiaTreno (RFI) has no CORS headers and is HTTP-only, so a static
// HTTPS site cannot call it directly (mixed content + CORS). We relay
// requests through public CORS proxies, trying each in turn.
const CORS_PROXIES = [
  {
    name: 'r.jina.ai',
    build: url => `https://r.jina.ai/${url}`,
    headers: { 'X-Return-Format': 'text' }
  },
  {
    name: 'allorigins',
    build: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  },
  {
    name: 'corsproxy.io',
    build: url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`
  }
]

const PROXY_TIMEOUT = 8000 // ms: a hanging proxy must not block the fallbacks

// Result of the last fetchViaProxy call, for the UI:
// { ok, via, attempts: [{ name, ok, detail }] }
let lastProxyReport = null

class ProxyFailure extends Error {}

function failureDetail(err) {
  if (err instanceof ProxyFailure) return err.message
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
  if (err instanceof TypeError) return 'network error or blocked (CORS)'
  return err.message || 'unknown error'
}

// "r.jina.ai: refused by ViaggiaTreno (Access Denied) · allorigins: blocked (CORS)"
function describeProxyReport(report) {
  if (!report) return ''
  return report.attempts.filter(a => !a.ok).map(a => `${a.name}: ${a.detail}`).join(' · ')
}

async function fetchViaProxy(targetUrl, { asJSON = true } = {}) {
  const attempts = []
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy.build(targetUrl), { headers: proxy.headers || {}, signal: AbortSignal.timeout(PROXY_TIMEOUT) })
      if (!res.ok) throw new ProxyFailure(`HTTP ${res.status}`)
      const text = await res.text()
      // A relay can answer 200 with the page ViaggiaTreno's firewall served to it.
      if (/access denied/i.test(text.slice(0, 400))) throw new ProxyFailure('refused by ViaggiaTreno (Access Denied)')
      let data = text
      if (asJSON) {
        try {
          data = JSON.parse(text)
        } catch {
          throw new ProxyFailure('unexpected response')
        }
      }
      attempts.push({ name: proxy.name, ok: true, detail: 'OK' })
      lastProxyReport = { ok: true, via: proxy.name, attempts }
      return data
    } catch (err) {
      attempts.push({ name: proxy.name, ok: false, detail: failureDetail(err) })
    }
  }
  lastProxyReport = { ok: false, via: null, attempts }
  throw new Error(describeProxyReport(lastProxyReport))
}

function nowAsViaggiaTrenoDate() {
  // ViaggiaTreno expects a JS Date.toString()-like value, e.g.
  // "Sun Aug 09 2026 07:56:06 GMT+0200 (Central European Summer Time)"
  return new Date().toString()
}
