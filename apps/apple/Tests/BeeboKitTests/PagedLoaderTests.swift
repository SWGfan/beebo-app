import XCTest
@testable import BeeboKit

struct Row: Identifiable, Sendable, Equatable {
    let id: Int
}

@MainActor
final class PagedLoaderTests: XCTestCase {
    private func makeLoader(total: Int, pageSize: Int = 60, prefetch: Int = 12, calls: CallLog = CallLog()) -> PagedLoader<Row> {
        PagedLoader<Row>(pageSize: pageSize, prefetchDistance: prefetch) { offset, limit in
            calls.offsets.append(offset)
            let end = min(total, offset + limit)
            let rows = offset < end ? (offset..<end).map { Row(id: $0) } : []
            return Page(items: rows, total: total, offset: offset, limit: limit)
        }
    }

    final class CallLog {
        var offsets: [Int] = []
    }

    func testFirstLoadFillsOnePage() async {
        let loader = makeLoader(total: 150)
        XCTAssertTrue(loader.hasMore)
        await loader.reload()
        XCTAssertEqual(loader.items.count, 60)
        XCTAssertEqual(loader.total, 150)
        XCTAssertTrue(loader.hasMore)
        XCTAssertTrue(loader.hasLoadedOnce)
    }

    func testLoadsAllPagesThenStops() async {
        let calls = CallLog()
        let loader = makeLoader(total: 150, calls: calls)
        await loader.reload()
        await loader.loadMore()
        await loader.loadMore()
        XCTAssertEqual(loader.items.count, 150)
        XCTAssertFalse(loader.hasMore)
        await loader.loadMore()
        XCTAssertEqual(calls.offsets, [0, 60, 120])
        XCTAssertEqual(loader.items.map(\.id), Array(0..<150))
    }

    func testFifteenHundredItemsPageInSixtyChunks() async {
        let calls = CallLog()
        let loader = makeLoader(total: 1500, calls: calls)
        await loader.reload()
        while loader.hasMore { await loader.loadMore() }
        XCTAssertEqual(loader.items.count, 1500)
        XCTAssertEqual(calls.offsets.count, 25)
        XCTAssertEqual(calls.offsets.last, 1440)
    }

    func testEmptyLibrary() async {
        let loader = makeLoader(total: 0)
        await loader.reload()
        XCTAssertTrue(loader.items.isEmpty)
        XCTAssertFalse(loader.hasMore)
        XCTAssertTrue(loader.hasLoadedOnce)
        XCTAssertNil(loader.failure)
    }

    func testItemAppearanceNearTheEndTriggersNextPage() async {
        let loader = makeLoader(total: 150, prefetch: 10)
        await loader.reload()
        loader.itemAppeared(loader.items[0])
        await Task.yield()
        XCTAssertEqual(loader.items.count, 60)
        loader.itemAppeared(loader.items[55])
        for _ in 0..<50 where loader.items.count == 60 { await Task.yield() }
        XCTAssertEqual(loader.items.count, 120)
    }

    func testDuplicatesFromTheServerAreDropped() async {
        let loader = PagedLoader<Row>(pageSize: 3) { offset, limit in
            let ids = offset == 0 ? [1, 2, 3] : [3, 4, 5]
            return Page(items: ids.map(Row.init), total: 6, offset: offset, limit: limit)
        }
        await loader.reload()
        await loader.loadMore()
        XCTAssertEqual(loader.items.map(\.id), [1, 2, 3, 4, 5])
        XCTAssertFalse(loader.hasMore)
    }

    func testFailureStopsAutoLoadingUntilRetry() async {
        var fail = true
        let loader = PagedLoader<Row>(pageSize: 2) { offset, limit in
            if fail { throw APIError.network(.timedOut) }
            return Page(items: [Row(id: offset)], total: 1, offset: offset, limit: limit)
        }
        await loader.reload()
        XCTAssertEqual(loader.failure, .network(.timedOut))
        XCTAssertFalse(loader.hasMore)
        XCTAssertFalse(loader.isLoading)
        fail = false
        await loader.retry()
        XCTAssertNil(loader.failure)
        XCTAssertEqual(loader.items.count, 1)
    }

    func testServerReturningNothingBeforeTotalDoesNotLoopForever() async {
        let calls = CallLog()
        let loader = PagedLoader<Row>(pageSize: 10) { offset, limit in
            calls.offsets.append(offset)
            return Page(items: offset == 0 ? [Row(id: 0)] : [], total: 50, offset: offset, limit: limit)
        }
        await loader.reload()
        await loader.loadMore()
        await loader.loadMore()
        XCTAssertFalse(loader.hasMore)
        XCTAssertEqual(calls.offsets, [0, 1])
    }

    func testReplacingTheFetcherDropsStaleResults() async {
        let loader = PagedLoader<Row>(pageSize: 5) { offset, limit in
            try await Task.sleep(nanoseconds: 150_000_000)
            return Page(items: [Row(id: 100)], total: 1, offset: offset, limit: limit)
        }
        let stale = Task { await loader.reload() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        loader.replaceFetch { offset, limit in
            Page(items: [Row(id: 1), Row(id: 2)], total: 2, offset: offset, limit: limit)
        }
        await loader.loadMore()
        await stale.value
        XCTAssertEqual(loader.items.map(\.id), [1, 2])
    }

    func testReloadStartsOver() async {
        let loader = makeLoader(total: 100)
        await loader.reload()
        await loader.loadMore()
        XCTAssertEqual(loader.items.count, 100)
        await loader.reload()
        XCTAssertEqual(loader.items.count, 60)
    }
}
