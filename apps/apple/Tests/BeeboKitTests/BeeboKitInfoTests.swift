import XCTest
@testable import BeeboKit

final class BeeboKitInfoTests: XCTestCase {
    func testDefaultPort() {
        XCTAssertEqual(BeeboKitInfo.defaultServerPort, 47811)
    }
}
