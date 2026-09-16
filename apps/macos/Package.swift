// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "WinTheCloudStudio", platforms: [.macOS(.v14)], products: [.executable(name: "WinTheCloudStudio", targets: ["WinTheCloudStudio"])], targets: [.executableTarget(name: "WinTheCloudStudio")], swiftLanguageModes: [.v5])
