# ADR 001: SwiftUI control plane, TypeScript production runtime

Accepted 2026-09-16. SwiftUI provides native navigation, file import, Keychain and AVKit playback. TypeScript owns the production domain, validation and tool integrations; the CLI calls the same service. This avoids duplicating orchestration in Swift and makes the media workflow testable without the UI. The development bundle requires a local Node installation and the checkout; standalone distribution packaging is deferred.
