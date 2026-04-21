// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Lux Client",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        // An xtool project should contain exactly one library product,
        // representing the main app.
        .library(
            name: "Lux Client",
            targets: ["native_lux"]
        ),
    ],
    targets: [
        .target(
            name: "native_lux",
            resources: [.copy("lux")]
        ),
    ]
)
