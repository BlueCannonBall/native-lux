// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Lux Client",
    platforms: [
        .iOS(.v17),
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
            exclude: ["WebClient/README.md", "WebClient/screenshot.png"],
            resources: [
                // An explicit list keeps Git metadata and upstream development files
                // out of the application, without editing the submodule.
                .copy("WebClient/index.html"),
                .copy("WebClient/index.js"),
                .copy("WebClient/pico.classless.min.css"),
                .copy("WebClient/mouse.png"),
                .copy("WebClient/icon.png"),
                .copy("WebClient/apple-touch-icon.png"),
                .copy("WebClient/favicon.ico"),
                .copy("WebClient/manifest.json"),
                .copy("WebClient/service-worker.js"),
                .copy("WebClient/LICENSE"),
                .copy("NativeAdapter.js"),
            ]
        ),
    ]
)
