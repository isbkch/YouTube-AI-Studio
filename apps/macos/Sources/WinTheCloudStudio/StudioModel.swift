import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class StudioModel: ObservableObject {
  let runtime = Runtime()
  @Published var projects: [Project] = []
  @Published var project: Project?
  @Published var selectedID: String?
  @Published var tab = "Overview"
  @Published var busy = false
  @Published var busyLabel = ""
  @Published var error: String?
  @Published var notice: String?
  @Published var report: DoctorReport?
  @Published var provider = UserDefaults.standard.string(forKey: "provider") ?? "mock"
  @Published var modelName = UserDefaults.standard.string(forKey: "modelName") ?? "gpt-5.4"
  private var activeRequest: String?
  private var lastRefresh = Date.distantPast
  init() {
    runtime.onJob = { [weak self] in
      guard let self, Date().timeIntervalSince(self.lastRefresh) > 0.3 else { return }
      self.lastRefresh = Date()
      Task { await self.refresh() }
    }
  }
  func load() async {
    await refresh()
    if provider == "openai" { await configureProvider() }
    await diagnose()
  }
  func refresh() async {
    do {
      projects = try await runtime.call("projects.list")
      if let id = selectedID {
        let snapshot: Project = try await runtime.call("project.get", ["projectId": id])
        if selectedID == id { project = snapshot }
      }
    } catch { self.error = error.localizedDescription }
  }
  func select(_ id: String?) async {
    selectedID = id
    project = nil
    tab = "Overview"
    await refresh()
  }
  func perform(_ method: String, label: String, params: [String: Any] = [:]) async {
    guard !busy else { return }
    busy = true
    busyLabel = label
    let requestID = UUID().uuidString
    activeRequest = requestID
    error = nil
    var args = params
    if let id = selectedID, args["projectId"] == nil { args["projectId"] = id }
    do {
      let _: AnyResponse = try await runtime.call(method, args, id: requestID)
      notice = label + " completed."
    } catch { self.error = error.localizedDescription }
    activeRequest = nil
    busy = false
    await refresh()
  }
  func create(title: String, description: String, minutes: Double) async {
    do {
      let p: Project = try await runtime.call(
        "project.create",
        ["title": title, "description": description, "targetDuration": minutes * 60])
      await select(p.id)
      tab = "Script"
    } catch { self.error = error.localizedDescription }
  }
  func cancel() async {
    guard let id = activeRequest else { return }
    let _: AnyResponse? = try? await runtime.call("request.cancel", ["requestId": id])
  }
  func diagnose() async {
    do { report = try await runtime.call("doctor") } catch {
      self.error = error.localizedDescription
    }
  }
  func configureProvider() async {
    do {
      var args: [String: Any] = ["provider": provider, "model": modelName]
      if provider == "openai" { args["apiKey"] = try Keychain.read() ?? "" }
      let _: AnyResponse = try await runtime.call("provider.configure", args)
      UserDefaults.standard.set(provider, forKey: "provider")
      UserDefaults.standard.set(modelName, forKey: "modelName")
    } catch {
      self.error = error.localizedDescription
      provider = "mock"
      let _: AnyResponse? = try? await runtime.call("provider.configure", ["provider": "mock"])
    }
  }
  func chooseFile(types: [UTType]) -> URL? {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = types
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    return panel.runModal() == .OK ? panel.url : nil
  }
  func chooseFiles(types: [UTType]) -> [URL] {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = types
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    return panel.runModal() == .OK ? panel.urls : []
  }
  func importVideo(_ urls: [URL] = []) async {
    let files = urls.isEmpty ? chooseFiles(types: [.movie, .video]) : urls
    guard !files.isEmpty else { return }
    tab = "Production"
    for file in files {
      await perform(
        "media.import", label: "Media import • \(file.lastPathComponent)",
        params: ["path": file.path])
    }
    tab = "Media"
  }
  func loadTranscript() async {
    guard let url = chooseFile(types: [.json]) else { return }
    do {
      let data = try Data(contentsOf: url)
      guard data.count <= 2_000_000 else {
        throw StudioFailure(
          kind: "INPUT", message: "Transcript is too large.",
          recovery: "Use the CLI to import JSON files up to 10 MB.", retryable: false)
      }
      let json = try JSONSerialization.jsonObject(with: data)
      await perform("transcript.load", label: "Transcript import", params: ["transcript": json])
    } catch { self.error = error.localizedDescription }
  }
  func openResolve() async {
    busy = true
    busyLabel = "Importing into Resolve"
    defer { busy = false }
    do {
      let r: ResolveReport = try await runtime.call(
        "resolve.import", ["projectId": selectedID ?? ""])
      if r.available {
        notice = "Opened \(r.timeline ?? "timeline") in Resolve."
      } else {
        error = r.reason ?? "Resolve is unavailable. Use the exported FCPXML."
      }
    } catch { self.error = error.localizedDescription }
  }
  func reveal(_ url: URL?) { if let url { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
}
