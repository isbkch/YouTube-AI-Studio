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
  @Published var aroll: ArollDraft?
  @Published var qa: QAReport?
  @Published var previsualization: Previsualization?
  @Published var teleprompter: TeleprompterDocument?
  @Published var packaging: PackagingDocument?
  @Published var thumbnails: ThumbnailDocument?
  private var thumbnailLoadID = UUID()
  @Published var captions: CaptionList = CaptionList(
    style: "none", events: [], skippedRecordings: [])
  @Published var finalMacros: [String] = []
  @Published var finalPresets: [String] = [
    "H.264 Master", "H.264 Narrative", "ProRes 422 HQ", "ProRes 422",
  ]
  @Published var provider = UserDefaults.standard.string(forKey: "provider") ?? "mock"
  @Published var transcriptionProvider =
    UserDefaults.standard.string(forKey: "transcriptionProvider") ?? "mock"
  @Published var modelName = UserDefaults.standard.string(forKey: "modelName") ?? "gpt-5.4"
  @Published var imageProvider = UserDefaults.standard.string(forKey: "imageProvider") ?? "mock"
  @Published var musicProvider = UserDefaults.standard.string(forKey: "musicProvider") ?? "library"
  @Published var imageModelName = UserDefaults.standard.string(forKey: "imageModelName") ?? ""
  @Published var musicModelName = UserDefaults.standard.string(forKey: "musicModelName") ?? ""
  /// The director hired for the selected project. Shared so the Storyboard
  /// cards and every Generate Storyboard button agree. Follows the plan's
  /// recorded persona when a new plan version lands, but never clobbers an
  /// in-progress choice while refreshes stream in between.
  @Published var selectedDirector = "craftsman"
  private var activeRequest: String?
  private var lastRefresh = Date.distantPast
  /** Plan version storyboard previews were last auto-rendered for. */
  private var autoPreviewedVersion: Int?
  /** Plan version the director selection was last synced from. */
  private var directorSyncedVersion: Int?
  init() {
    runtime.onJob = { [weak self] in
      guard let self, Date().timeIntervalSince(self.lastRefresh) > 0.3 else { return }
      self.lastRefresh = Date()
      Task { await self.refresh() }
    }
  }
  func load() async {
    await refresh()
    await configureProvider()
    await diagnose()
  }
  func refresh() async {
    do {
      projects = try await runtime.call("projects.list")
      if let id = selectedID {
        let snapshot: Project = try await runtime.call("project.get", ["projectId": id])
        if selectedID == id {
          project = snapshot
          if let plan = snapshot.plan, directorSyncedVersion != plan.version {
            directorSyncedVersion = plan.version
            selectedDirector = plan.persona
          }
        }
      }
    } catch { self.error = error.localizedDescription }
    await loadThumbnails()
    await loadCaptions()
    await maybeRenderPreviews()
  }
  /// Punch-line captions are derived from the approved plan + transcripts on
  /// demand, so the storyboard badge always matches what the build will burn.
  /// The list has no version of its own, so a request is discarded unless the
  /// plan it was computed against is still current when it returns.
  private func loadCaptions() async {
    guard let id = selectedID, let plan = project?.plan, plan.captions != "none"
    else {
      captions = CaptionList(style: "none", events: [], skippedRecordings: [])
      return
    }
    let version = plan.version
    let style = plan.captions
    captions = CaptionList(style: style, events: [], skippedRecordings: [])
    if let list: CaptionList = try? await runtime.call(
      "captions.list", ["projectId": id]),
      selectedID == id,
      project?.plan?.version == version,
      project?.plan?.captions == style
    {
      captions = list
    }
  }
  /** Storyboard previews render themselves once per new plan version so the
   * creator sees the actual graphics and 3D clips before approving. Cache
   * hits make unchanged scenes instant; the manual button retries. */
  private func maybeRenderPreviews() async {
    guard !busy, let p = project, let plan = p.plan,
      p.status == "AWAITING_STORYBOARD_APPROVAL",
      autoPreviewedVersion != plan.version,
      plan.scenes.contains(where: { scene in
        scene.enabled
          && (scene.visual.graphic != nil
            || (scene.broll ?? []).contains { $0.asset.engine == "blender" })
      })
    else { return }
    autoPreviewedVersion = plan.version
    await perform("previews.render", label: "Storyboard previews")
  }
  func renderPreviews() async {
    guard let plan = project?.plan else { return }
    autoPreviewedVersion = plan.version
    await perform("previews.render", label: "Storyboard previews")
  }
  func select(_ id: String?) async {
    selectedID = id
    project = nil
    error = nil
    notice = nil
    aroll = nil
    qa = nil
    packaging = nil
    thumbnails = nil
    autoPreviewedVersion = nil
    directorSyncedVersion = nil
    selectedDirector = "craftsman"
    tab = "Overview"
    await refresh()
  }
  @discardableResult
  func perform(_ method: String, label: String, params: [String: Any] = [:]) async -> Bool {
    guard !busy else { return false }
    busy = true
    busyLabel = label
    let requestID = UUID().uuidString
    activeRequest = requestID
    error = nil
    notice = nil
    var succeeded = false
    var args = params
    if let id = selectedID, args["projectId"] == nil { args["projectId"] = id }
    do {
      let _: AnyResponse = try await runtime.call(method, args, id: requestID)
      notice = label + " completed."
      succeeded = true
    } catch { self.error = error.localizedDescription }
    activeRequest = nil
    busy = false
    await refresh()
    return succeeded
  }
  func create(title: String, description: String, minutes: Double, autonomy: String = "supervised")
    async
  {
    do {
      let p: Project = try await runtime.call(
        "project.create",
        [
          "title": title, "description": description,
          "targetDuration": minutes * 60, "autonomy": autonomy,
        ])
      await select(p.id)
      tab = "Pre-Production"
    } catch { self.error = error.localizedDescription }
  }
  /// The Producer — deterministic autonomy for the machine gates. Manual
  /// catch-up for autonomous projects; script and publication stay human.
  func runProducer() async {
    await perform("producer.advance", label: "Run Producer")
  }
  func setAutonomy(_ mode: String) async {
    await perform(
      "project.autonomy", label: "Autonomy • \(mode)", params: ["mode": mode])
  }
  /** Deleting removes the project's workspace; the files the creator imported
   * from live outside the library and are never touched. */
  struct DeleteResult: Decodable {
    let title: String
    let recordingsRemoved: Int
  }
  func delete(_ target: Project) async {
    guard !busy else { return }
    busy = true
    busyLabel = "Deleting project"
    error = nil
    defer { busy = false }
    do {
      let r: DeleteResult = try await runtime.call(
        "project.delete", ["projectId": target.id])
      if selectedID == target.id {
        selectedID = nil
        project = nil
        tab = "Overview"
      }
      await refresh()
      notice =
        r.recordingsRemoved == 0
        ? "Deleted “\(r.title)”."
        : "Deleted “\(r.title)” — \(r.recordingsRemoved) imported recording copy(s) removed. The files you imported from are untouched."
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
      var args: [String: Any] = [
        "provider": provider,
        "transcriptionProvider": transcriptionProvider,
        "model": modelName,
        "imageProvider": imageProvider,
        "musicProvider": musicProvider,
        "imageModel": imageModelName,
        "musicModel": musicModelName,
      ]
      if provider == "openai" || transcriptionProvider == "openai" || imageProvider == "openai" {
        args["apiKey"] = try Keychain.read() ?? ""
      }
      if imageProvider == "gemini" || musicProvider == "gemini" {
        args["geminiApiKey"] = try Keychain.read("gemini") ?? ""
      }
      let _: AnyResponse = try await runtime.call("provider.configure", args)
      UserDefaults.standard.set(provider, forKey: "provider")
      UserDefaults.standard.set(transcriptionProvider, forKey: "transcriptionProvider")
      UserDefaults.standard.set(modelName, forKey: "modelName")
      UserDefaults.standard.set(imageProvider, forKey: "imageProvider")
      UserDefaults.standard.set(musicProvider, forKey: "musicProvider")
      UserDefaults.standard.set(imageModelName, forKey: "imageModelName")
      UserDefaults.standard.set(musicModelName, forKey: "musicModelName")
    } catch {
      self.error = error.localizedDescription
      provider = "mock"
      transcriptionProvider = "mock"
      imageProvider = "mock"
      musicProvider = "library"
      let _: AnyResponse? = try? await runtime.call(
        "provider.configure",
        [
          "provider": "mock", "transcriptionProvider": "mock",
          "imageProvider": "mock", "musicProvider": "library",
        ])
    }
    await loadThumbnails()
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
  func importFCPTranscripts() async {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = true
    panel.message =
      "Choose a Final Cut library, an event, or the folder containing your media. Word-level speech analysis is discovered next to the clips."
    guard panel.runModal() == .OK, let url = panel.url else { return }
    await perform(
      "transcript.fcp", label: "Final Cut transcript import", params: ["path": url.path])
  }
  func draftAroll() async {
    guard !busy, let id = selectedID else { return }
    busy = true
    busyLabel = "Drafting A-roll cut"
    error = nil
    notice = nil
    aroll = nil
    defer { busy = false }
    do {
      aroll = try await runtime.call("aroll.draft", ["projectId": id])
      notice = "A-roll draft ready."
    } catch { self.error = error.localizedDescription }
    await refresh()
  }
  /** Milestone 4 — Director pre-visualization returns the run sheet directly. */
  func previsualize() async {
    guard !busy, let id = selectedID else { return }
    busy = true
    busyLabel = "Director pre-visualization"
    error = nil
    defer { busy = false }
    do {
      let r: PrevisualizationResult = try await runtime.call(
        "previsualization.run", ["projectId": id])
      previsualization = r.previsualization
      notice = "Run sheet ready for script v\(r.previsualization.scriptVersion)."
    } catch { self.error = error.localizedDescription }
    await refresh()
  }
  func loadTeleprompter() async {
    guard let id = selectedID else { return }
    do {
      teleprompter = try await runtime.call("teleprompter.get", ["projectId": id])
    } catch { self.error = error.localizedDescription }
  }
  /** Milestone 5 — packaging proposal, approval and one-shot publish. */
  func packageVideo() async {
    guard !busy, let id = selectedID else { return }
    busy = true
    busyLabel = "Packaging Agent"
    error = nil
    defer { busy = false }
    do {
      let r: PackagingResult = try await runtime.call("packaging.run", ["projectId": id])
      packaging = PackagingDocument(
        version: r.snapshot.packaging?.version ?? 0,
        packaging: r.packaging,
        description: r.description)
      notice = "Packaging v\(packaging?.version ?? 0) ready for review."
    } catch { self.error = error.localizedDescription }
    await refresh()
  }
  func loadPackaging() async {
    guard let id = selectedID else { return }
    let document: PackagingDocument? = try? await runtime.call("packaging.get", ["projectId": id])
    if selectedID == id { packaging = document }
  }
  func loadThumbnails() async {
    guard let id = selectedID, let version = project?.packaging?.version else {
      thumbnails = nil
      return
    }
    let token = UUID()
    thumbnailLoadID = token
    let document: ThumbnailDocument? = try? await runtime.call("thumbnails.get", ["projectId": id])
    if selectedID == id && project?.packaging?.version == version && thumbnailLoadID == token {
      thumbnails = document
    }
  }
  @discardableResult
  func renderThumbnails(_ slots: [ThumbnailSlot]) async -> Bool {
    guard let d = thumbnails, d.projectId == selectedID else { return false }
    return await perform(
      "thumbnails.render", label: "Thumbnail rendering",
      params: [
        "projectId": d.projectId, "packagingVersion": d.state.current.packagingVersion,
        "slots": slots.map { ["slot": $0.id, "expectedRevision": $0.version] as [String: Any] },
      ])
  }
  func regenerateThumbnail(_ slot: ThumbnailSlot) async {
    guard let d = thumbnails, d.projectId == selectedID else { return }
    await perform(
      "thumbnails.regenerate", label: "Regenerate thumbnail \(slot.id)",
      params: [
        "projectId": d.projectId, "packagingVersion": d.state.current.packagingVersion,
        "slot": slot.id, "expectedRevision": slot.version,
      ])
  }
  @discardableResult
  func updateThumbnail(_ slot: ThumbnailSlot, headline: String, direction: String, concept: String)
    async -> Bool
  {
    guard let d = thumbnails, d.projectId == selectedID else { return false }
    return await perform(
      "thumbnails.update", label: "Thumbnail edit",
      params: [
        "projectId": d.projectId, "packagingVersion": d.state.current.packagingVersion,
        "slot": slot.id, "expectedRevision": slot.version, "conceptId": concept,
        "headline": headline, "direction": direction,
      ])
  }
  func selectThumbnail(_ slot: ThumbnailSlot?, revision: Int? = nil) async {
    guard let d = thumbnails, d.projectId == selectedID else { return }
    await perform(
      "thumbnails.select", label: "Thumbnail selection",
      params: [
        "projectId": d.projectId, "packagingVersion": d.state.current.packagingVersion,
        "slot": slot?.id as Any? ?? NSNull(),
        "expectedRevision": slot?.version as Any? ?? NSNull(),
        "revision": (revision ?? slot?.currentRevision) as Any? ?? NSNull(),
      ])
  }
  func exportThumbnails() async {
    guard !busy, let d = thumbnails, d.projectId == selectedID else { return }
    let panel = NSOpenPanel()
    panel.title = "Export A/B thumbnails"
    panel.prompt = "Export here"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.message = "A new folder will contain A.jpg, B.jpg and their revision manifest."
    guard panel.runModal() == .OK, let folder = panel.url else { return }
    busy = true
    busyLabel = "Export thumbnails"
    error = nil
    defer { busy = false }
    do {
      let result: ThumbnailExport = try await runtime.call(
        "thumbnails.export",
        [
          "projectId": d.projectId, "packagingVersion": d.state.current.packagingVersion,
          "destination": folder.path,
        ])
      notice = "A/B thumbnails exported."
      reveal(URL(fileURLWithPath: result.directory))
    } catch { self.error = error.localizedDescription }
  }
  func approvePackaging(_ version: Int) async {
    await perform(
      "packaging.approve", label: "Packaging approval", params: ["version": version])
    await loadPackaging()
  }
  func publish() async {
    await perform("publish.run", label: "Publish to YouTube")
  }
  func importPlan() async {
    guard let url = chooseFile(types: [.json]) else { return }
    do {
      let data = try Data(contentsOf: url)
      guard data.count <= 10_000_000 else {
        throw StudioFailure(
          kind: "INPUT", message: "Plan is too large.",
          recovery: "Use the CLI to import plan JSON files up to 10 MB.", retryable: false)
      }
      let json = try JSONSerialization.jsonObject(with: data)
      await perform("plan.import", label: "Plan import", params: ["plan": json])
    } catch { self.error = error.localizedDescription }
  }
  func proposeRange(_ range: String, request: String) async {
    await perform(
      "revision.range", label: "Range revision proposal",
      params: ["range": range, "request": request])
  }
  /** The decision layer: propose generated B-roll, music and SFX as a patch. */
  func proposeVisualPass() async {
    await perform("visuals.propose", label: "Visual direction pass")
  }
  func loadQA() async {
    guard let id = selectedID else { return }
    qa = try? await runtime.call("qa.get", ["projectId": id])
  }
  func loadFinalOptions() async {
    if let options: FinalOptions = try? await runtime.call("final.macros") {
      finalMacros = options.macros
      finalPresets = options.presets
    }
  }
  func renderFinal(preset: String, macro: String) async {
    var params: [String: Any] = ["preset": preset]
    if !macro.isEmpty { params["macroId"] = macro }
    await perform("final.render", label: "Resolve final render", params: params)
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
