import Foundation
import Combine

@MainActor
public final class PagedLoader<Item: Identifiable & Sendable>: ObservableObject where Item.ID: Hashable & Sendable {
    public typealias Fetch = (_ offset: Int, _ limit: Int) async throws -> Page<Item>

    @Published public private(set) var items: [Item] = []
    @Published public private(set) var total: Int?
    @Published public private(set) var isLoading = false
    @Published public private(set) var failure: APIError?
    @Published public private(set) var hasLoadedOnce = false

    public let pageSize: Int
    public let prefetchDistance: Int

    private var fetch: Fetch
    private var generation = 0
    private var nextOffset = 0
    private var seen = Set<Item.ID>()

    public init(pageSize: Int = 60, prefetchDistance: Int = 12, fetch: @escaping Fetch) {
        self.pageSize = pageSize
        self.prefetchDistance = prefetchDistance
        self.fetch = fetch
    }

    public var hasMore: Bool {
        guard failure == nil else { return false }
        guard let total else { return true }
        return nextOffset < total
    }

    public func replaceFetch(_ newFetch: @escaping Fetch) {
        fetch = newFetch
        resetState()
    }

    public func reset() {
        resetState()
    }

    public func reload() async {
        resetState()
        await loadMore()
    }

    public func retry() async {
        failure = nil
        await loadMore()
    }

    public func loadMore() async {
        guard !isLoading, hasMore else { return }
        isLoading = true
        let mine = generation
        let offset = nextOffset
        do {
            let page = try await fetch(offset, pageSize)
            guard mine == generation else { return }
            var fresh: [Item] = []
            for item in page.items where seen.insert(item.id).inserted {
                fresh.append(item)
            }
            items.append(contentsOf: fresh)
            total = page.total
            nextOffset = offset + page.items.count
            if page.items.isEmpty { total = min(page.total, nextOffset) }
            hasLoadedOnce = true
            isLoading = false
        } catch {
            guard mine == generation else { return }
            failure = (error as? APIError) ?? .network(.other(error.localizedDescription))
            hasLoadedOnce = true
            isLoading = false
        }
    }

    public func itemAppeared(_ item: Item) {
        guard hasMore, !isLoading else { return }
        if items.suffix(prefetchDistance).contains(where: { $0.id == item.id }) {
            Task { await loadMore() }
        }
    }

    private func resetState() {
        generation += 1
        items = []
        total = nil
        failure = nil
        isLoading = false
        hasLoadedOnce = false
        nextOffset = 0
        seen.removeAll()
    }
}
