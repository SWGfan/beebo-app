import test from 'node:test'
import assert from 'node:assert/strict'
import { createPagedList, windowRange, gridMove, railSlice } from '../app/js/util/pagination.js'

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: 'i' + i }))

function pagedServer(total, opts = {}) {
  const calls = []
  return {
    calls,
    fetchPage: (offset, limit) => {
      calls.push([offset, limit])
      return Promise.resolve({ items: mk(total).slice(offset, offset + limit), total: opts.omitTotal ? undefined : total })
    }
  }
}

test('pager loads pages lazily and stops at total', async () => {
  const s = pagedServer(250)
  const p = createPagedList({ pageSize: 100, fetchPage: s.fetchPage })
  assert.equal(p.size(), 0)
  await p.loadMore()
  assert.equal(p.size(), 100)
  assert.equal(p.total(), 250)
  assert.equal(p.isComplete(), false)
  await p.loadMore()
  await p.loadMore()
  assert.equal(p.size(), 250)
  assert.equal(p.isComplete(), true)
  assert.equal(await p.loadMore(), false)
  assert.deepEqual(s.calls, [[0, 100], [100, 100], [200, 100]])
})

test('ensure(index) fetches only as many pages as needed', async () => {
  const s = pagedServer(1300)
  const p = createPagedList({ pageSize: 100, fetchPage: s.fetchPage })
  assert.equal(await p.ensure(5), true)
  assert.equal(s.calls.length, 1)
  assert.equal(await p.ensure(250), true)
  assert.equal(s.calls.length, 3)
  assert.equal(await p.ensure(5000), false)
  assert.equal(p.size(), 1300)
})

test('1300 shows are never fetched in one go', async () => {
  const s = pagedServer(1300)
  const p = createPagedList({ pageSize: 100, fetchPage: s.fetchPage })
  await p.ensure(0)
  assert.equal(p.size(), 100)
  assert.ok(p.size() < 1300)
})

test('concurrent loadMore calls share one request', async () => {
  const s = pagedServer(300)
  const p = createPagedList({ pageSize: 100, fetchPage: s.fetchPage })
  await Promise.all([p.loadMore(), p.loadMore(), p.ensure(50)])
  assert.equal(s.calls.length, 1)
})

test('legacy server (no paging): { all:true } takes the whole list once and never asks again', async () => {
  let calls = 0
  const p = createPagedList({ pageSize: 100, fetchPage: () => { calls++; return Promise.resolve({ items: mk(1300), all: true }) } })
  await p.loadMore()
  assert.equal(p.size(), 1300)
  assert.equal(p.isComplete(), true)
  await p.loadMore()
  await p.ensure(1299)
  assert.equal(calls, 1)
})

test('server without total: a short page ends the list', async () => {
  const s = pagedServer(150, { omitTotal: true })
  const p = createPagedList({ pageSize: 100, fetchPage: s.fetchPage })
  await p.loadMore()
  assert.equal(p.isComplete(), false)
  await p.loadMore()
  assert.equal(p.size(), 150)
  assert.equal(p.isComplete(), true)
})

test('empty first page completes immediately', async () => {
  const p = createPagedList({ pageSize: 10, fetchPage: () => Promise.resolve({ items: [], total: 0 }) })
  await p.loadMore()
  assert.equal(p.isComplete(), true)
  assert.equal(p.size(), 0)
})

test('a failed page rejects, keeps what was loaded, and can be retried', async () => {
  let fail = false
  const p = createPagedList({
    pageSize: 10,
    fetchPage: (o, l) => (fail ? Promise.reject(new Error('net')) : Promise.resolve({ items: mk(50).slice(o, o + l), total: 50 }))
  })
  await p.loadMore()
  fail = true
  await assert.rejects(p.loadMore())
  assert.equal(p.size(), 10)
  assert.equal(p.isLoading(), false)
  fail = false
  await p.loadMore()
  assert.equal(p.size(), 20)
})

test('reset drops a late answer for the old query', async () => {
  let release
  const p = createPagedList({ pageSize: 10, fetchPage: () => new Promise((r) => { release = () => r({ items: mk(10), total: 10 }) }) })
  const pending = p.loadMore()
  p.reset()
  release()
  assert.equal(await pending, false)
  assert.equal(p.size(), 0)
})

test('shouldPrefetch fires near the loaded end only', async () => {
  const s = pagedServer(500)
  const p = createPagedList({ pageSize: 100, fetchPage: s.fetchPage })
  await p.loadMore()
  assert.equal(p.shouldPrefetch(10, 12), false)
  assert.equal(p.shouldPrefetch(90, 12), true)
  await p.ensure(499)
  assert.equal(p.shouldPrefetch(499, 12), false) // complete
})

test('windowRange: bounded DOM around the focus', () => {
  const w = windowRange({ total: 1300, columns: 6, focusIndex: 600, rowsBefore: 2, rowsAfter: 4 })
  assert.equal(w.totalRows, Math.ceil(1300 / 6))
  assert.equal(w.firstRow, 98)
  assert.equal(w.lastRow, 104)
  assert.equal(w.startIndex, 98 * 6)
  assert.equal(w.endIndex, 105 * 6)
  assert.ok(w.endIndex - w.startIndex <= 7 * 6)
})

test('windowRange clamps at both ends and handles tiny/empty lists', () => {
  assert.deepEqual(windowRange({ total: 1300, columns: 6, focusIndex: 0 }), { totalRows: 217, firstRow: 0, lastRow: 4, startIndex: 0, endIndex: 30 })
  const end = windowRange({ total: 1300, columns: 6, focusIndex: 1299 })
  assert.equal(end.lastRow, 216)
  assert.equal(end.endIndex, 1300)
  assert.equal(windowRange({ total: 0, columns: 6, focusIndex: 0 }).endIndex, 0)
  const tiny = windowRange({ total: 3, columns: 6, focusIndex: 2 })
  assert.equal(tiny.startIndex, 0)
  assert.equal(tiny.endIndex, 3)
  assert.equal(windowRange({ total: 10, columns: 0, focusIndex: 99 }).endIndex, 10) // columns floors to 1
})

test('gridMove: arrows inside a virtual grid', () => {
  // 13 items, 5 columns: rows are 0-4, 5-9, 10-12
  assert.equal(gridMove(0, 'right', 5, 13), 1)
  assert.equal(gridMove(4, 'right', 5, 13), 4) // end of row: stay
  assert.equal(gridMove(5, 'left', 5, 13), 5) // start of row: stay
  assert.equal(gridMove(2, 'up', 5, 13), -1) // leave the grid
  assert.equal(gridMove(7, 'up', 5, 13), 2)
  assert.equal(gridMove(7, 'down', 5, 13), 12) // short last row: clamp to last item
  assert.equal(gridMove(3, 'down', 5, 13), 8)
  assert.equal(gridMove(12, 'right', 5, 13), 12)
  assert.equal(gridMove(12, 'down', 5, 13), 12)
  assert.equal(gridMove(0, 'left', 5, 0), -1)
})

test('railSlice', () => {
  assert.deepEqual(railSlice(mk(30), 20).more, true)
  assert.equal(railSlice(mk(30), 20).items.length, 20)
  assert.deepEqual(railSlice(mk(5), 20), { items: mk(5), more: false })
  assert.deepEqual(railSlice(null, 3), { items: [], more: false })
})
