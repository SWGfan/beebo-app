// Pagination + windowing maths. DOM-free.
//
// Two separate concerns (a 1300-show library must never be rendered, or even fetched, in one go
// if the server lets us not):
//
//  1. createPagedList  - "give me the next N items". Works against a server that pages
//     (limit/offset, optional `total`) AND against today's servers, which ignore limit/offset and
//     answer with the whole list: the fetchPage adapter flags that with { all: true } and the list
//     simply takes the full result once (see api.js listPage()).
//  2. windowRange      - which rows of a big grid are worth having in the DOM right now. Everything
//     outside the window is not rendered (its <img> elements do not exist, so their decoded bitmaps
//     are freed - TVs have very little RAM).

/**
 * @param {{pageSize?:number, fetchPage:function(number,number):Promise<{items:Array,total?:number,hasMore?:boolean,all?:boolean}>}} opts
 */
export function createPagedList(opts) {
  var pageSize = opts.pageSize > 0 ? opts.pageSize : 40
  var items = []
  var total = null
  var complete = false
  var inflight = null
  var generation = 0 // bumped by reset() so a late answer for an old query is dropped

  function loadMore() {
    if (complete) return Promise.resolve(false)
    if (inflight) return inflight
    var gen = generation
    var offset = items.length
    var p = Promise.resolve(opts.fetchPage(offset, pageSize)).then(
      function (page) {
        if (gen !== generation) return false
        inflight = null
        var got = page && Array.isArray(page.items) ? page.items : []
        if (page && page.all) {
          // Server ignored limit/offset and sent everything: take it and stop asking.
          items = got.slice()
          total = items.length
          complete = true
          return true
        }
        items = items.concat(got)
        if (page && typeof page.total === 'number' && page.total >= 0) total = page.total
        if (got.length === 0) complete = true
        else if (page && page.hasMore === false) complete = true
        else if (total !== null && items.length >= total) complete = true
        else if (page && page.hasMore !== true && total === null && got.length < pageSize) complete = true
        return got.length > 0
      },
      function (err) {
        if (gen === generation) inflight = null
        throw err
      }
    )
    inflight = p
    return p
  }

  function ensure(index) {
    if (items.length > index || complete) return Promise.resolve(items.length > index)
    return loadMore().then(function (progressed) {
      if (!progressed) return items.length > index
      return ensure(index)
    })
  }

  return {
    loadMore: loadMore,
    ensure: ensure,
    reset: function () { generation++; items = []; total = null; complete = false; inflight = null },
    items: function () { return items },
    size: function () { return items.length },
    total: function () { return total },
    isComplete: function () { return complete },
    isLoading: function () { return inflight !== null },
    /** Good moment to fetch the next page? (focus is within `threshold` items of the loaded end) */
    shouldPrefetch: function (focusIndex, threshold) {
      return !complete && inflight === null && items.length - focusIndex <= (threshold === undefined ? 12 : threshold)
    }
  }
}

/**
 * Rows of a virtual grid to keep in the DOM around the focused item.
 * `total` may be larger than what has been loaded so far (skeleton rows are simply not drawn).
 * Returns first/last row (inclusive) and item index range [startIndex, endIndex).
 */
export function windowRange(o) {
  var columns = Math.max(1, o.columns | 0)
  var total = Math.max(0, o.total | 0)
  var totalRows = Math.ceil(total / columns)
  if (totalRows === 0) return { totalRows: 0, firstRow: 0, lastRow: -1, startIndex: 0, endIndex: 0 }
  var focus = Math.min(Math.max(0, o.focusIndex | 0), total - 1)
  var focusRow = Math.floor(focus / columns)
  var before = o.rowsBefore === undefined ? 2 : Math.max(0, o.rowsBefore | 0)
  var after = o.rowsAfter === undefined ? 4 : Math.max(0, o.rowsAfter | 0)
  var firstRow = Math.max(0, focusRow - before)
  var lastRow = Math.min(totalRows - 1, focusRow + after)
  return {
    totalRows: totalRows,
    firstRow: firstRow,
    lastRow: lastRow,
    startIndex: firstRow * columns,
    endIndex: Math.min(total, (lastRow + 1) * columns)
  }
}

/**
 * Index reached from `index` by a D-pad move inside a virtual grid, or -1 for "leave the grid"
 * (up from the first row). Left/right stop at row ends (no wrap); down from a short last row
 * lands on the last item.
 */
export function gridMove(index, dir, columns, total) {
  var cols = Math.max(1, columns | 0)
  if (total <= 0) return -1
  var i = Math.min(Math.max(0, index), total - 1)
  if (dir === 'left') return i % cols === 0 ? i : i - 1
  if (dir === 'right') return i % cols === cols - 1 || i === total - 1 ? i : i + 1
  if (dir === 'up') return i - cols < 0 ? -1 : i - cols
  if (dir === 'down') {
    if (i + cols < total) return i + cols
    var lastRow = Math.floor((total - 1) / cols)
    return Math.floor(i / cols) < lastRow ? total - 1 : i // already on the last row: stay
  }
  return i
}

/** First `n` items plus whether more exist - used by the home rails ("See all" tile). */
export function railSlice(items, n) {
  var list = Array.isArray(items) ? items : []
  return { items: list.slice(0, n), more: list.length > n }
}
