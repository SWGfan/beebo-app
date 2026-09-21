// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BeeboKit",
    platforms: [.iOS(.v16), .tvOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "BeeboKit", targets: ["BeeboKit"]),
    ],
    targets: [
        .target(name: "BeeboKit"),
        .testTarget(name: "BeeboKitTests", dependencies: ["BeeboKit"]),
    ]
)
