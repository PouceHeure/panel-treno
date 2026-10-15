const test = require('node:test')
const assert = require('node:assert')

const store = new Map()
global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
const f = require('../js/modules/follow.js')

test('favourites toggle and keep the newest first', () => {
  store.clear()
  assert.strictEqual(f.toggleFavorite('S1', 'A'), true)
  assert.strictEqual(f.toggleFavorite('S2', 'B'), true)
  assert.deepStrictEqual(f.loadFavorites().map(x => x.id), ['S2', 'S1'])
  assert.strictEqual(f.isFavorite('S1'), true)
  assert.strictEqual(f.toggleFavorite('S1', 'A'), false)
  assert.strictEqual(f.isFavorite('S1'), false)
})

test('one pinned train at a time', () => {
  store.clear()
  assert.strictEqual(f.loadPinned(), null)
  assert.strictEqual(f.togglePinned({ number: '12', from: 'S0', date: '1' }), true)
  assert.strictEqual(f.isPinned('12', '1'), true)
  assert.strictEqual(f.togglePinned({ number: '13', from: 'S0', date: '1' }), true)
  assert.strictEqual(f.isPinned('12', '1'), false)
  assert.strictEqual(f.togglePinned({ number: '13', from: 'S0', date: '1' }), false)
  assert.strictEqual(f.loadPinned(), null)
})

test('broken storage does not throw', () => {
  store.set('panelTreno.favorites', '{not json')
  assert.deepStrictEqual(f.loadFavorites(), [])
})
