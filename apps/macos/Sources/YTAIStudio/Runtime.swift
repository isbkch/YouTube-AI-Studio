import Foundation
import Security
import SwiftUI

@MainActor final class Runtime: ObservableObject {
  @Published var connected = false
  @Published var root = ""
  @Published var startupError: String?
  var onJob: (() -> Void)?
  private var process: Process?
  private var stdin: FileHandle?
  private var buffer = Data()
  private var pending: [String: CheckedContinuation<Data, Error>] = [:]
  private var errorTail = ""
  var runtimeRoot: String {
    ProcessInfo.processInfo.environment["WTS_RUNTIME_ROOT"] ?? Bundle.main.object(
      forInfoDictionaryKey: "WTSRuntimeRoot") as? String ?? FileManager.default.currentDirectoryPath
  }
  func launch() {
    guard process == nil else { return }
    let fm = FileManager.default
    let override = UserDefaults.standard.string(forKey: "nodePath")
    let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map {
      String($0) + "/node"
    }
    let candidates =
      [override].compactMap { $0 } + paths + [
        "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
      ]
    guard let node = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) else {
      startupError =
        "Node.js was not found. Install Node.js 24 or newer, or set its executable path in Settings."
      return
    }
    let script = runtimeRoot + "/packages/orchestrator/src/ipc.ts"
    guard fm.fileExists(atPath: script) else {
      startupError =
        "The local runtime is missing at \(runtimeRoot). Run bun install from the repository to restore it."
      return
    }
    let child = Process()
    let input = Pipe()
    let output = Pipe()
    let errors = Pipe()
    child.executableURL = URL(fileURLWithPath: node)
    child.arguments = ["--import", runtimeRoot + "/node_modules/tsx/dist/loader.mjs", script]
    child.currentDirectoryURL = URL(fileURLWithPath: runtimeRoot)
    var env = ProcessInfo.processInfo.environment
    env["PATH"] =
      ([
        URL(fileURLWithPath: node).deletingLastPathComponent().path, "/opt/homebrew/bin",
        "/usr/local/bin", "/usr/bin", "/bin",
      ] + (env["PATH"] ?? "").split(separator: ":").map(String.init)).joined(separator: ":")
    if let home = UserDefaults.standard.string(forKey: "projectRoot"), !home.isEmpty {
      env["WTS_HOME"] = home
    }
    if CommandLine.arguments.contains("--demo") { env["WTS_HOME"] = runtimeRoot + "/.demo" }
    child.environment = env
    child.standardInput = input
    child.standardOutput = output
    child.standardError = errors
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      Task { @MainActor in self?.receive(data) }
    }
    errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      Task { @MainActor in
        self?.errorTail = String(
          ((self?.errorTail ?? "") + String(decoding: data, as: UTF8.self)).suffix(4000))
      }
    }
    child.terminationHandler = { [weak self] p in
      Task { @MainActor in self?.terminated(p.terminationStatus) }
    }
    do {
      try child.run()
      process = child
      stdin = input.fileHandleForWriting
    } catch { startupError = error.localizedDescription }
  }
  private func receive(_ data: Data) {
    buffer.append(data)
    while let newline = buffer.firstIndex(of: 10) {
      let line = buffer.prefix(upTo: newline)
      buffer.removeSubrange(...newline)
      guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
        continue
      }
      if obj["event"] as? String == "ready" {
        connected = true
        root = obj["root"] as? String ?? ""
        continue
      }
      if obj["event"] as? String == "job" {
        onJob?()
        continue
      }
      if ["previews.scene", "thumbnails.updated"].contains(obj["event"] as? String ?? "") {
        // Progressive storyboard previews: each rendered scene refreshes the grid.
        onJob?()
        continue
      }
      guard let id = obj["id"] as? String, let continuation = pending.removeValue(forKey: id) else {
        continue
      }
      if let error = obj["error"], let bytes = try? JSONSerialization.data(withJSONObject: error),
        let failure = try? JSONDecoder().decode(StudioFailure.self, from: bytes)
      {
        continuation.resume(throwing: failure)
      } else if let result = obj["result"],
        let bytes = try? JSONSerialization.data(
          withJSONObject: result, options: [.fragmentsAllowed])
      {
        continuation.resume(returning: bytes)
      } else {
        continuation.resume(
          throwing: StudioFailure(
            kind: "IPC", message: "The runtime returned an invalid response.",
            recovery: "Restart the app.", retryable: true))
      }
    }
  }
  private func terminated(_ status: Int32) {
    connected = false
    process = nil
    stdin = nil
    let error = StudioFailure(
      kind: "IPC", message: "Production runtime stopped (\(status)).",
      recovery: "Restart the app. Completed assets remain on disk.\n\(errorTail)", retryable: true)
    for c in pending.values { c.resume(throwing: error) }
    pending.removeAll()
    startupError = error.localizedDescription
  }
  func call<T: Decodable>(
    _ method: String, _ params: [String: Any] = [:], id: String = UUID().uuidString,
    as type: T.Type = T.self
  ) async throws -> T {
    guard connected, let input = stdin else {
      throw StudioFailure(
        kind: "IPC", message: "The local runtime is not connected.",
        recovery: "Check Settings and restart the app.", retryable: true)
    }
    let packet =
      try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
      + Data([10])
    let result: Data = try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      do { try input.write(contentsOf: packet) } catch {
        pending.removeValue(forKey: id)?.resume(throwing: error)
      }
    }
    return try JSONDecoder().decode(T.self, from: result)
  }
  func stop() {
    try? stdin?.close()
    process?.terminate()
  }
}

enum Keychain {
  static let service = "com.isbkch.YouTube-AI-Studio"
  static func read(_ account: String = "openai") throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account, kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw failure(status) }
    return String(data: data, encoding: .utf8)
  }
  static func save(_ key: String, account: String = "openai") throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let data = Data(key.utf8)
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      let added = SecItemAdd(item as CFDictionary, nil)
      if added != errSecSuccess { throw failure(added) }
    } else if status != errSecSuccess {
      throw failure(status)
    }
  }
  static func failure(_ status: OSStatus) -> StudioFailure {
    StudioFailure(
      kind: "KEYCHAIN",
      message: SecCopyErrorMessageString(status, nil) as String? ?? "Keychain operation failed.",
      recovery: "Unlock your login keychain and try again.", retryable: true)
  }
}
