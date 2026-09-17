// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "YTAIStudio", platforms: [.macOS(.v14)], products: [.executable(name: "YTAIStudio", targets: ["YTAIStudio"])], targets: [.executableTarget(name: "YTAIStudio", linkerSettings: [.linkedFramework("AVKit"), .linkedFramework("AVFoundation"), .linkedFramework("Security")])], swiftLanguageModes: [.v5])
