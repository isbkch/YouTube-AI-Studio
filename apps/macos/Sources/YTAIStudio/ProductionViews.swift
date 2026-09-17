import AVKit
import AppKit
import SwiftUI

struct MediaThumbnail: View {
  let url: URL
  var seconds: Double = 1
  @State private var image: NSImage?
  var body: some View {
    ZStack {
      Color.studioSurface
      if let image {
        Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
      } else {
        Image(systemName: "play.rectangle").font(.largeTitle).foregroundStyle(.secondary)
      }
    }.clipped().task(id: "\(url.absoluteString)@\(seconds)") {
      image = nil
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      generator.appliesPreferredTrackTransform = true
      generator.requestedTimeToleranceBefore = .zero
      generator.requestedTimeToleranceAfter = .zero
      generator.maximumSize = CGSize(width: 640, height: 360)
      if let result = try? await generator.image(
        at: CMTime(seconds: seconds, preferredTimescale: 600)),
        !Task.isCancelled
      {
        image = NSImage(cgImage: result.image, size: .zero)
      }
    }
  }
}
struct StoryboardView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @State private var editing: ProductionScene?
  @State private var density = "balanced"
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 7) {
          Text("Make the production decisions visible.").studioHeading(20)
          Text(
            p.plan?.director.summary ?? "Generate a plan from the approved script and transcript."
          ).font(.caption).foregroundStyle(.secondary).lineLimit(3)
          if let plan = p.plan {
            let bed = plan.audioDesign?.music
            let sfx = plan.audioDesign?.sfx ?? []
            if plan.brollCount > 0 || bed != nil || !sfx.isEmpty {
              Label(
                "\(plan.brollCount) B-roll · \(bed?.trackId ?? "no music bed") · \(sfx.count) SFX",
                systemImage: "waveform.and.photo"
              ).font(.caption).foregroundStyle(Color.studioAccent)
            } else {
              Label(
                "No B-roll or music yet — the visual pass can propose them.",
                systemImage: "photo.on.rectangle"
              ).font(.caption).foregroundStyle(.secondary)
            }
            if let coverage = plan.scriptCoverage, !coverage.sentences.isEmpty {
              if coverage.omitted.isEmpty {
                Label(
                  "Script coverage: all \(coverage.sentences.count) sentences included",
                  systemImage: "checklist"
                ).font(.caption).foregroundStyle(Color.studioSuccess)
              } else {
                Menu {
                  ForEach(Array(coverage.omitted.enumerated()), id: \.offset) { _, sentence in
                    VStack(alignment: .leading) {
                      Text(sentence.text).lineLimit(2)
                      if let reason = sentence.reason {
                        Text(reason).font(.caption).foregroundStyle(.secondary)
                      }
                    }
                  }
                } label: {
                  Label(
                    "Script coverage: \(coverage.included.count) included · \(coverage.omitted.count) omitted",
                    systemImage: "checklist"
                  ).font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
        Spacer()
        if let plan = p.plan {
          VStack(alignment: .trailing, spacing: 8) {
            Text("\(plan.scenes.count) scenes • v\(plan.version)").font(.caption).foregroundStyle(
              .secondary)
            HStack(spacing: 8) {
              Text("Visual density").font(.caption).foregroundStyle(.secondary)
              Picker("", selection: $density) {
                Text("Minimal").tag("minimal")
                Text("Balanced").tag("balanced")
                Text("Rich").tag("rich")
              }.pickerStyle(.segmented).frame(width: 200).disabled(m.busy)
            }
            Button(
              density == plan.density
                ? "Regenerate Storyboard" : "Regenerate as \(density)"
            ) {
              Task {
                await m.perform(
                  "plan.generate", label: "Director • storyboard", params: ["density": density])
              }
            }.buttonStyle(QuietButtonStyle()).disabled(
              m.busy
                || !["MEDIA_IMPORTED", "AWAITING_STORYBOARD_APPROVAL"].contains(p.status))
            let previewable = plan.scenes.filter { $0.enabled && $0.visual.graphic != nil }
            let rendered = previewable.filter { scene in
              p.assets?.contains {
                $0.sceneId == scene.id && $0.type == "remotion-render"
                  && $0.productionPlanVersion == plan.version
              } ?? false
            }
            if !previewable.isEmpty {
              if rendered.count == previewable.count {
                Label(
                  "Previews rendered \(previewable.count)/\(previewable.count)",
                  systemImage: "sparkles"
                ).font(.caption).foregroundStyle(Color.studioSuccess)
              } else {
                Label(
                  "Previews rendered \(rendered.count)/\(previewable.count)",
                  systemImage: "sparkles"
                ).font(.caption).foregroundStyle(.secondary)
              }
            }
            Button("Re-render Previews") {
              Task { await m.renderPreviews() }
            }.buttonStyle(QuietButtonStyle()).disabled(
              m.busy
                || ![
                  "AWAITING_STORYBOARD_APPROVAL", "AWAITING_ROUGH_CUT_APPROVAL",
                  "READY_TO_RENDER",
                ].contains(p.status))
            Button("Propose Visual Pass") {
              Task {
                await m.proposeVisualPass()
                m.tab = "Review"
              }
            }.buttonStyle(QuietButtonStyle()).disabled(
              m.busy
                || ![
                  "AWAITING_STORYBOARD_APPROVAL", "AWAITING_ROUGH_CUT_APPROVAL",
                  "READY_TO_RENDER",
                ].contains(p.status))
            if p.planApproval?.version == plan.version {
              Label("Storyboard approved", systemImage: "checkmark.circle.fill").font(.caption)
                .foregroundStyle(Color.studioSuccess)
            } else {
              Button("Approve Storyboard v\(plan.version)") {
                Task {
                  await m.perform(
                    "plan.approve", label: "Storyboard approval", params: ["version": plan.version])
                }
              }.buttonStyle(QuietButtonStyle()).disabled(
                m.busy || p.status != "AWAITING_STORYBOARD_APPROVAL")
            }
            Button("Build Rough Cut") {
              m.tab = "Production"
              Task { await m.perform("build", label: "Production") }
            }.buttonStyle(PrimaryActionButtonStyle()).disabled(
              m.busy || p.planApproval?.version != plan.version)
          }
        }
      }
      ScrollView {
        LazyVGrid(
          columns: [GridItem(.adaptive(minimum: 300), spacing: 18)], alignment: .leading,
          spacing: 18
        ) {
          ForEach(p.plan?.scenes ?? []) { scene in SceneCard(p: p, scene: scene) { editing = scene }
          }
        }
      }
      if p.plan == nil {
        Spacer()
        Text("The storyboard appears here after Director planning.").foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
        Spacer()
      }
    }.padding(28)
      .onAppear { density = p.plan?.density ?? "balanced" }
      .onChange(of: p.plan?.version) { _, _ in density = p.plan?.density ?? "balanced" }
      .sheet(item: $editing) { scene in
        SceneEditor(p: p, scene: scene).environmentObject(m)
      }
  }
}
struct SceneCard: View {
  let p: Project
  let scene: ProductionScene
  let edit: () -> Void
  var previewOffset: Double {
    min(1, Double(scene.durationFrames) / Double(p.plan?.frameRate ?? 30) / 2)
  }
  var currentAsset: Asset? {
    p.assets?.last {
      $0.sceneId == scene.id && $0.type == "remotion-render"
        && $0.productionPlanVersion == p.plan?.version
    }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ZStack(alignment: .bottomLeading) {
        if let a = currentAsset, let url = p.url(a.path) {
          MediaThumbnail(url: url, seconds: previewOffset)
        } else if scene.visual.graphic == nil || !scene.enabled,
          let r = p.recordings.first(where: { $0.id == scene.camera.recordingId }),
          let url = p.url(r.proxyPath ?? r.path)
        {
          MediaThumbnail(
            url: url,
            seconds: Double(scene.sourceInFrame) / Double(p.plan?.frameRate ?? 30) + previewOffset)
        } else {
          VStack(alignment: .leading, spacing: 16) {
            Text(scene.visual.graphic?.template.uppercased() ?? "PRESENTER").font(
              .system(size: 10, weight: .semibold)
            ).tracking(2).foregroundStyle(Color.studioAccent)
            Text(scene.visual.graphic?.parameters.title ?? scene.visual.description)
              .studioHeading(20).lineLimit(3)
            if let nodes = scene.visual.graphic?.parameters.nodes, !nodes.isEmpty {
              Text(nodes.joined(separator: " → ")).font(.caption).foregroundStyle(.secondary)
            }
          }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(Color.studioAccent.opacity(0.06))
        }
        Text(
          timestamp(Double(scene.startFrame) / Double(p.plan?.frameRate ?? 30)) + "–"
            + timestamp(
              Double(scene.startFrame + scene.durationFrames) / Double(p.plan?.frameRate ?? 30))
        ).font(.system(size: 10, weight: .medium, design: .monospaced)).foregroundStyle(.white)
          .padding(7).background(
            .black.opacity(0.65), in: RoundedRectangle(cornerRadius: 5)
          ).padding(12)
      }.frame(height: 172).clipped()
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text(scene.id.uppercased()).font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundStyle(.secondary)
          Spacer()
          Text(
            !scene.enabled
              ? "Visual disabled"
              : currentAsset != nil
                ? (currentAsset!.reused ? "Cached" : "Rendered")
                : scene.visual.graphic == nil ? "A-roll only" : "Planned"
          ).font(.system(size: 10)).foregroundStyle(Color.studioAccent)
        }
        Text(
          "src \(scene.sourceInFrame)–\(scene.sourceInFrame + scene.durationFrames) f"
            + " · \(scene.transcriptSegmentIds?.count ?? 0) seg"
            + " · \(String(format: "%.1f", scene.audio?.gainDb ?? 0)) dB"
            + (scene.musicIntensity.map { String(format: " · music %.0f%%", $0 * 100) } ?? "")
            + (scene.selection.map { String(format: " · match %.2f", $0.score) } ?? "")
            + (scene.selection?.bridged == true ? " · bridged" : "")
        ).font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
        Text(scene.narration).font(.system(size: 13)).lineSpacing(3).lineLimit(4).frame(
          height: 74, alignment: .topLeading)
        if let chapter = scene.chapterTitle {
          Label(chapter, systemImage: "bookmark.fill").font(.system(size: 10, weight: .medium))
            .foregroundStyle(Color.studioAccent).lineLimit(1)
        }
        ForEach(scene.broll ?? []) { b in
          HStack(alignment: .top, spacing: 8) {
            if b.asset.engine == "blender",
              let clip = p.assets?.last(where: {
                $0.sceneId == scene.id && $0.type == "broll-clip"
                  && $0.productionPlanVersion == p.plan?.version
              }),
              let url = p.url(clip.path)
            {
              MediaThumbnail(
                url: url,
                seconds: min(1, Double(b.durationFrames) / Double(p.plan?.frameRate ?? 30) / 2)
              ).frame(width: 64, height: 38).clipShape(RoundedRectangle(cornerRadius: 5))
            }
            VStack(alignment: .leading, spacing: 2) {
              Label(
                "\(b.placement == "inset" ? "B-roll inset" : "B-roll full-frame") · \(b.motion) · \(b.asset.engine == "blender" ? "3D \(b.asset.template)" : (b.asset.parameters.style ?? "still"))",
                systemImage: "photo.on.rectangle.angled"
              ).font(.system(size: 10, weight: .medium)).foregroundStyle(Color.studioAccent)
              Text("“\(b.narrationHook)”").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
          }
        }
        Text(scene.rationale).font(.caption).foregroundStyle(.secondary).lineLimit(2).frame(
          height: 31, alignment: .topLeading)
        HStack {
          Label(
            scene.visual.graphic?.template ?? "Presenter",
            systemImage: scene.visual.graphic == nil ? "person.crop.rectangle" : "rectangle.3.group"
          ).font(.caption).foregroundStyle(.secondary)
          Spacer()
          Button("Inspect / Edit", action: edit).buttonStyle(QuietButtonStyle())
        }
      }.padding(16)
    }.studioCard(cornerRadius: 12).clipShape(
      RoundedRectangle(cornerRadius: 12))
  }
}
struct SceneEditor: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) var dismiss
  let p: Project
  let scene: ProductionScene
  @State private var template = "Presenter"
  @State private var title = ""
  @State private var subtitle = ""
  @State private var nodes = ""
  @State private var emphasis = -1
  @State private var quote = ""
  @State private var attribution = ""
  @State private var fileName = ""
  @State private var codeLines = ""
  @State private var removedLines = ""
  @State private var highlight = -1
  @State private var terminalLines = ""
  @State private var layers = ""
  @State private var failedLayer = -1
  @State private var method = "GET"
  @State private var path = ""
  @State private var steps = ""
  @State private var failureStep = -1
  @State private var unit = ""
  @State private var series = ""
  @State private var threshold = ""
  @State private var goodDirection = "up"
  @State private var basis = "narration"
  @State private var failedNode = 0
  @State private var recovered = false
  @State private var punch = 1.0
  @State private var enabled = true

  private static let templates = [
    "Presenter", "ChapterTitle", "Callout", "Quote", "ArchitectureFlow",
    "ArchitectureDiagram", "RequestFlow", "CodeReveal", "Terminal", "CodeDiff",
    "MetricChart", "FailureAnimation",
  ]

  private func csv(_ text: String) -> [String] {
    text.split(separator: ",").map {
      $0.trimmingCharacters(in: .whitespaces)
    }.filter { !$0.isEmpty }
  }

  private func lineList(_ text: String) -> [String] {
    text.split(whereSeparator: \.isNewline).map(String.init).filter {
      !$0.trimmingCharacters(in: .whitespaces).isEmpty
    }
  }

  private var terminalRows: [[String: Any]] {
    lineList(terminalLines).map { line in
      let parts = line.split(separator: ":", maxSplits: 1)
      let kind =
        parts.count == 2
          && ["input", "output", "error"].contains(String(parts[0]).lowercased())
        ? String(parts[0]).lowercased() : "input"
      let text =
        parts.count == 2
        ? parts[1].trimmingCharacters(in: .whitespaces) : line
      return ["kind": kind, "text": String(text.prefix(100))]
    }
  }

  private var layerDicts: [[String: Any]] {
    lineList(layers).compactMap { line in
      let parts = line.split(separator: ":", maxSplits: 1)
      guard parts.count == 2 else { return nil }
      let components = csv(String(parts[1]))
      guard !components.isEmpty else { return nil }
      return ["name": String(parts[0].prefix(28)), "components": components]
    }
  }

  private var seriesValues: [Double]? {
    let values = series.split(separator: ",").compactMap {
      Double($0.trimmingCharacters(in: .whitespaces))
    }
    return values.count >= 3 ? values : nil
  }

  /** Full parameter object for the selected template; nil when incomplete. */
  private var params: [String: Any]? {
    switch template {
    case "Quote":
      return quote.isEmpty
        ? nil
        : [
          "quote": String(quote.prefix(300)),
          "attribution": String(attribution.prefix(80)),
        ]
    case "ArchitectureFlow":
      let list = Array(csv(nodes).prefix(6))
      return list.count < 2
        ? nil
        : ["title": title, "subtitle": subtitle, "nodes": list, "emphasis": emphasis]
    case "ArchitectureDiagram":
      let list = layerDicts
      return list.count < 2
        ? nil
        : ["title": title, "subtitle": subtitle, "layers": list, "failedLayer": failedLayer]
    case "RequestFlow":
      let list = Array(csv(steps).prefix(6))
      return (list.count < 2 || path.isEmpty)
        ? nil
        : [
          "title": title, "subtitle": subtitle, "method": method,
          "path": String(path.prefix(60)), "steps": list, "failureStep": failureStep,
        ]
    case "CodeReveal":
      let list = Array(lineList(codeLines).map { String($0.prefix(90)) }.prefix(12))
      return (list.isEmpty || fileName.isEmpty)
        ? nil
        : ["title": title, "fileName": fileName, "lines": list, "highlight": highlight]
    case "Terminal":
      let rows = terminalRows
      return rows.count < 2 ? nil : ["title": title, "lines": rows]
    case "CodeDiff":
      let removed = Array(lineList(removedLines).map { String($0.prefix(90)) }.prefix(8))
      let added = Array(lineList(codeLines).map { String($0.prefix(90)) }.prefix(8))
      return (added.isEmpty || fileName.isEmpty)
        ? nil
        : ["title": title, "fileName": fileName, "removed": removed, "added": added]
    case "MetricChart":
      guard let values = seriesValues, !unit.isEmpty else { return nil }
      return [
        "title": title, "subtitle": subtitle, "unit": String(unit.prefix(10)),
        "series": values, "threshold": Double(threshold),
        "goodDirection": goodDirection, "basis": basis,
      ]
    case "FailureAnimation":
      let list = Array(csv(nodes).prefix(6))
      return list.count < 2
        ? nil
        : [
          "title": title, "subtitle": subtitle, "nodes": list,
          "failedNode": min(failedNode, max(0, list.count - 1)), "recovered": recovered,
        ]
    default:
      return title.isEmpty ? nil : ["title": title, "subtitle": subtitle]
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Text("Direct \(scene.id)").font(.title2)
        Spacer()
        Button("Done") { dismiss() }.buttonStyle(QuietButtonStyle())
      }
      Text(scene.narration).font(.callout).foregroundStyle(.secondary).lineLimit(5)
      Picker("Visual", selection: $template) {
        ForEach(Self.templates, id: \.self) { Text($0).tag($0) }
      }
      if template != "Presenter" {
        Group {
          switch template {
          case "Quote":
            TextField("Quotation (as spoken)", text: $quote, axis: .vertical)
            TextField("Attribution", text: $attribution)
          case "ArchitectureFlow":
            TextField("Title (up to 100 characters)", text: $title)
            TextField("Subtitle", text: $subtitle)
            TextField("Nodes, separated by commas (2–6)", text: $nodes)
            Stepper(
              "Emphasis node: \(emphasis == -1 ? "none" : String(emphasis))", value: $emphasis,
              in: -1...5)
          case "ArchitectureDiagram":
            TextField("Title (up to 100 characters)", text: $title)
            TextField("Subtitle", text: $subtitle)
            Text("Layers, one per line — “Name: Component, Component”").font(.caption)
              .foregroundStyle(.secondary)
            TextEditor(text: $layers).font(.system(size: 12, design: .monospaced)).frame(height: 72)
              .border(Color.studioSurface)
            Stepper(
              "Failed layer: \(failedLayer == -1 ? "none" : String(failedLayer))",
              value: $failedLayer, in: -1...3)
          case "RequestFlow":
            TextField("Title (up to 100 characters)", text: $title)
            TextField("Subtitle", text: $subtitle)
            Picker("Method", selection: $method) {
              ForEach(["GET", "POST", "PUT", "PATCH", "DELETE"], id: \.self) { Text($0) }
            }
            TextField("Path (e.g. /api/documents/:id)", text: $path)
            TextField("Steps, separated by commas (2–6)", text: $steps)
            Stepper(
              "Failure step: \(failureStep == -1 ? "none" : String(failureStep))",
              value: $failureStep, in: -1...5)
          case "CodeReveal":
            TextField("Title (up to 100 characters)", text: $title)
            TextField("File name", text: $fileName)
            Text("Code lines (1–12, one per line)").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $codeLines).font(.system(size: 12, design: .monospaced)).frame(
              height: 120
            )
            .border(Color.studioSurface)
            Stepper(
              "Highlight: \(highlight == -1 ? "none" : String(highlight))", value: $highlight,
              in: -1...11)
          case "Terminal":
            TextField("Title (up to 100 characters)", text: $title)
            Text("Lines, one per line — prefix “input:”, “output:” or “error:”")
              .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $terminalLines).font(.system(size: 12, design: .monospaced))
              .frame(height: 96).border(Color.studioSurface)
          case "CodeDiff":
            TextField("Title (up to 100 characters)", text: $title)
            TextField("File name", text: $fileName)
            Text("Removed lines (optional, one per line)").font(.caption).foregroundStyle(
              .secondary)
            TextEditor(text: $removedLines).font(.system(size: 12, design: .monospaced)).frame(
              height: 56
            )
            .border(Color.studioSurface)
            Text("Added lines (one per line)").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $codeLines).font(.system(size: 12, design: .monospaced)).frame(
              height: 72
            )
            .border(Color.studioSurface)
          case "MetricChart":
            TextField("Title (up to 100 characters)", text: $title)
            TextField("Subtitle", text: $subtitle)
            TextField("Unit (e.g. ms, %, x)", text: $unit)
            TextField("Series, comma-separated numbers (3–24)", text: $series)
            TextField("Threshold (blank for none)", text: $threshold)
            Picker("Good direction", selection: $goodDirection) {
              Text("Up").tag("up")
              Text("Down").tag("down")
            }
            Picker("Series basis", selection: $basis) {
              Text("Spoken in narration").tag("narration")
              Text("Illustrative (labeled on screen)").tag("illustrative")
            }
          case "FailureAnimation":
            TextField("Title (up to 100 characters)", text: $title)
            TextField("Subtitle", text: $subtitle)
            TextField("Nodes, separated by commas (2–6)", text: $nodes)
            Stepper("Failed node: \(failedNode)", value: $failedNode, in: 0...5)
            Toggle("Recovered by the end", isOn: $recovered)
          default:
            TextField("Title (up to 100 characters)", text: $title)
            TextField("Subtitle", text: $subtitle)
          }
        }
      }
      HStack {
        Text("Presenter punch-in")
        Slider(value: $punch, in: 1...1.35)
        Text("\(punch, specifier: "%.2f")×").monospacedDigit().frame(width: 55)
      }
      Toggle("Enable visual instruction (A-roll remains when disabled)", isOn: $enabled)
      DisclosureGroup("Source & transcript provenance") {
        Text(
          "Recording: \(scene.camera.recordingId)\nSource frames: \(scene.sourceInFrame)–\(scene.sourceInFrame + scene.durationFrames) at \(p.plan?.frameRate ?? 30) fps\nTranscript segments: \(scene.transcriptSegmentIds?.joined(separator: ", ") ?? "none")\nAudio gain: \(String(format: "%.1f", scene.audio?.gainDb ?? 0)) dB\nMusic intensity: \(String(format: "%.0f", (scene.musicIntensity ?? 1) * 100))%\nTransition: \(scene.transition ?? "cut")\(selectionDetail)"
        ).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).frame(
          maxWidth: .infinity, alignment: .leading)
      }
      if let a = p.assets?.last(where: { $0.sceneId == scene.id && $0.type == "remotion-render" }) {
        DisclosureGroup("Asset provenance") {
          Text(
            "Asset: \(a.assetId)\nJob: \(a.jobId)\nPlan: v\(a.productionPlanVersion)\nTemplate: \(a.template ?? "—")\nInput: \(a.inputHash)\nOutput: \(a.outputHash)\n\(a.path)"
          ).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).frame(
            maxWidth: .infinity, alignment: .leading)
        }
      }
      Spacer(minLength: 0)
      Text(
        "A proposal will show the change before you apply it. Applying creates a new plan version and requires storyboard approval."
      ).font(.caption).foregroundStyle(.secondary)
      HStack {
        Spacer()
        Button("Propose This Change") {
          Task {
            let parameters = params ?? [:]
            let visual: [String: Any] =
              template == "Presenter"
              ? [
                "type": "presenter", "description": "Presenter carries the explanation.",
                "graphic": NSNull(),
              ]
              : [
                "type": "graphic", "description": title.isEmpty ? template : title,
                "graphic": [
                  "engine": "remotion", "template": template, "templateVersion": "1.0.0",
                  "parameters": parameters,
                ],
              ]
            let operations: [[String: Any]] = [
              ["type": "replaceVisual", "sceneId": scene.id, "visual": visual],
              [
                "type": "updateFraming", "sceneId": scene.id,
                "framing": punch > 1.1 ? "close" : "medium", "punchIn": punch,
              ], ["type": "disableScene", "sceneId": scene.id, "disabled": !enabled],
            ]
            await m.perform(
              "revision.edit", label: "Revision proposal",
              params: [
                "request": "Creator edited \(scene.id) in the storyboard.",
                "operations": operations,
              ])
            m.tab = "Review"
            dismiss()
          }
        }.buttonStyle(PrimaryActionButtonStyle()).disabled(
          m.busy || (template != "Presenter" && params == nil))
      }
    }.padding(28).frame(width: 720, height: 700).textFieldStyle(.roundedBorder).onAppear {
      template = scene.visual.graphic?.template ?? "Presenter"
      let g = scene.visual.graphic?.parameters
      title = g?.title ?? ""
      subtitle = g?.subtitle ?? ""
      nodes = g?.nodes?.joined(separator: ", ") ?? "Requests, Service, Database"
      emphasis = g?.emphasis ?? -1
      quote = g?.quote ?? ""
      attribution = g?.attribution ?? ""
      fileName = g?.fileName ?? ""
      highlight = g?.highlight ?? -1
      layers =
        g?.layers?.map { "\($0.name): \($0.components.joined(separator: ", "))" }
        .joined(separator: "\n") ?? ""
      failedLayer = g?.failedLayer ?? -1
      method = g?.method ?? "GET"
      path = g?.path ?? ""
      steps = g?.steps?.joined(separator: ", ") ?? ""
      failureStep = g?.failureStep ?? -1
      unit = g?.unit ?? ""
      series = g?.series?.map { String($0) }.joined(separator: ", ") ?? ""
      threshold = g?.threshold.map { String($0) } ?? ""
      goodDirection = g?.goodDirection ?? "up"
      basis = g?.basis ?? "narration"
      failedNode = g?.failedNode ?? 0
      recovered = g?.recovered ?? false
      switch g?.lines?.first {
      case .terminal:
        terminalLines =
          g?.lines?.map {
            if case .terminal(let kind, let text) = $0 { return "\(kind): \(text)" }
            return $0.text
          }.joined(separator: "\n") ?? ""
      default:
        codeLines = g?.lines?.map(\.text).joined(separator: "\n") ?? ""
      }
      punch = scene.camera.punchIn
      enabled = scene.enabled
    }
  }

  private var selectionDetail: String {
    guard let selection = scene.selection else { return "" }
    var detail = "\nSelection score: \(String(format: "%.2f", selection.score))"
    if selection.bridged { detail += " (bridged without direct match)" }
    if let alternates = selection.alternates, !alternates.isEmpty {
      detail +=
        "\nAlternates: "
        + alternates.map {
          "\($0.recordingId) \(String(format: "%.1f", $0.start))–\(String(format: "%.1f", $0.end))s (\(String(format: "%.2f", $0.score)))"
        }.joined(separator: "; ")
    }
    return detail
  }
}
struct ProductionView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  var jobs: [Job] {
    guard let run = p.jobs?.first?.runId else { return [] }
    return (p.jobs ?? []).filter { $0.runId == run }.reversed()
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        HStack {
          VStack(alignment: .leading, spacing: 6) {
            Text("Production, with a paper trail.").font(.title2)
            Text(
              "Independent jobs run when their dependencies are ready. Completed outputs are reused when their inputs match."
            ).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Button("Build / Retry") { Task { await m.perform("build", label: "Production") } }
            .buttonStyle(QuietButtonStyle())
            .disabled(m.busy || p.planApproval?.version != p.plan?.version || p.plan == nil)
        }
        if !m.busy
          && ["TRANSCRIBING", "PLANNING", "GENERATING_ASSETS", "ASSEMBLING"].contains(p.status)
        {
          Button("Recover Interrupted Work") {
            Task { await m.perform("project.recover", label: "Recovery") }
          }.buttonStyle(QuietButtonStyle())
          Text(
            "Recovery checks for an active owner before unlocking interrupted work. Completed assets remain available."
          ).font(.caption).foregroundStyle(.secondary)
        }
        if jobs.isEmpty {
          Text("Import media or start production to see the job queue.").foregroundStyle(.secondary)
            .padding(.vertical, 50)
        }
        ForEach(jobs) { j in
          VStack(alignment: .leading, spacing: 12) {
            HStack {
              Image(
                systemName: j.status == "COMPLETE"
                  ? "checkmark.circle.fill"
                  : j.status == "FAILED"
                    ? "exclamationmark.circle"
                    : j.status == "RUNNING" ? "gearshape.2" : "circle.dashed"
              ).foregroundStyle(j.status == "FAILED" ? Color.orange : .studioAccent)
              Text(j.label).font(.headline)
              Spacer()
              Text(j.status).font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
            }
            if j.status == "RUNNING" { ProgressView(value: j.progress).tint(.studioAccent) }
            if let error = j.error {
              Text(error.message + "\n" + error.recovery).font(.caption).foregroundStyle(.orange)
                .textSelection(.enabled)
            }
            DisclosureGroup("Log · \(j.retryCount) retries") {
              Text(j.logs.isEmpty ? "No additional log entries." : j.logs.joined(separator: "\n"))
                .font(.system(size: 10, design: .monospaced)).textSelection(.enabled).frame(
                  maxWidth: .infinity, alignment: .leading)
            }
          }.padding(18).studioCard(cornerRadius: 11)
        }
        if let build = p.currentBuild {
          HStack {
            Button("Visual QA Report") { m.tab = "Visual QA" }.buttonStyle(QuietButtonStyle())
            Button("Review Rough Cut") { m.tab = "Review" }.buttonStyle(QuietButtonStyle())
            Button("Reveal Resolve Export") { m.reveal(p.url(build.exportPath)) }.buttonStyle(
              QuietButtonStyle())
          }
        }
        CostView(p: p)
      }.padding(28)
    }
  }
}
