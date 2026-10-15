// What the person follows, kept in this browser only (localStorage): favourite stations and one pinned train.
const FAVORITES_KEY = 'panelTreno.favorites'
const PINNED_KEY = 'panelTreno.pinned'
const FAVORITES_MAX = 12

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key))
    return value ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable: following is a convenience */ }
}

function loadFavorites() {
  const list = readJson(FAVORITES_KEY, [])
  return Array.isArray(list) ? list.filter(f => f && f.id && f.name) : []
}

function isFavorite(id) {
  return loadFavorites().some(f => f.id === id)
}

// Adds or removes the station; returns true when it is now a favourite.
function toggleFavorite(id, name) {
  const list = loadFavorites()
  const without = list.filter(f => f.id !== id)
  if (without.length !== list.length) {
    writeJson(FAVORITES_KEY, without)
    return false
  }
  writeJson(FAVORITES_KEY, [{ id, name: name || id }, ...without].slice(0, FAVORITES_MAX))
  return true
}

// One train at a time: following another one replaces it.
function loadPinned() {
  const pinned = readJson(PINNED_KEY, null)
  return pinned && pinned.number && pinned.from && pinned.date ? pinned : null
}

function isPinned(number, date) {
  const pinned = loadPinned()
  return !!pinned && String(pinned.number) === String(number) && String(pinned.date) === String(date)
}

// Pins the train, or unpins it when it already is; returns true when it is now pinned.
function togglePinned(train) {
  if (isPinned(train.number, train.date)) {
    try { localStorage.removeItem(PINNED_KEY) } catch { /* nothing to remove */ }
    return false
  }
  writeJson(PINNED_KEY, train)
  return true
}

function clearPinned() {
  try { localStorage.removeItem(PINNED_KEY) } catch { /* nothing to remove */ }
}

if (typeof module !== 'undefined') {
  module.exports = { loadFavorites, isFavorite, toggleFavorite, loadPinned, isPinned, togglePinned, clearPinned }
}
