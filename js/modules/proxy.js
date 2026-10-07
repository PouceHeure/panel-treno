// =======================
// CORS Proxy Helper
// =======================
// ViaggiaTreno (RFI) has no CORS headers and is HTTP-only, so a static
// HTTPS site cannot call it directly (mixed content + CORS). We relay
// requests through public CORS proxies, trying each in turn.
const CORS_PROXIES = [
  {
    build: url => `https://r.jina.ai/${url}`,
    headers: { 'X-Return-Format': 'text' }
  },
  {
    build: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  },
  {
    build: url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`
  }
]

const PROXY_TIMEOUT = 8000 // ms: a hanging proxy must not block the fallbacks

async function fetchViaProxy(targetUrl, { asJSON = true } = {}) {
  let lastErr
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy.build(targetUrl), { headers: proxy.headers || {}, signal: AbortSignal.timeout(PROXY_TIMEOUT) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      return asJSON ? JSON.parse(text) : text
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

function nowAsViaggiaTrenoDate() {
  // ViaggiaTreno expects a JS Date.toString()-like value, e.g.
  // "Sun Aug 09 2026 07:56:06 GMT+0200 (Central European Summer Time)"
  return new Date().toString()
}
