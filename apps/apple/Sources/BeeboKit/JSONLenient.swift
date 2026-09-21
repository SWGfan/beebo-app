import Foundation

extension KeyedDecodingContainer {
    func lenient<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }

    func lenientOptional<T: Decodable>(_ key: Key) -> T? {
        try? decodeIfPresent(T.self, forKey: key)
    }
}

private struct SkipElement: Decodable {}

struct LossyArray<Element: Decodable>: Decodable {
    let elements: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                out.append(element)
            } else {
                _ = try? container.decode(SkipElement.self)
            }
        }
        elements = out
    }
}

extension KeyedDecodingContainer {
    func lossyList<T: Decodable>(_ key: Key) -> [T] {
        (try? decodeIfPresent(LossyArray<T>.self, forKey: key))?.elements ?? []
    }
}
