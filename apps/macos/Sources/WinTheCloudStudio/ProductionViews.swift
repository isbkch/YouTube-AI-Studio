import AVKit
import AppKit
import SwiftUI

struct MediaThumbnail: View {
  let url: URL
  @State private var image: NSImage?
  var body: some View {
    ZStack {
      Color.studioSurface
      if let image {
        Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
      } else {
        Image(systemName: "play.rectangle").font(.largeTitle).foregroundStyle(.secondary)
      }
    }.clipped().task(id: url) {
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      generator.appliesPreferredTrackTransform = true
      generator.requestedTimeToleranceBefore = .zero
      generator.requestedTimeToleranceAfter = .zero
      generator.maximumSize = CGSize(width: 640, height: 360)
      if let result = try? await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600)) {
        image = NSImage(cgImage: result.image, size: .zero)
      }
    }
  }
}
struct StoryboardView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @State private var editing: ProductionScene?
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 7) {
          Text("Make the production decisions visible.").studioHeading(20)
          Text(
            p.plan?.director.summary ?? "Generate a plan from the approved script and transcript."
          ).font(.caption).foregroundStyle(.secondary).lineLimit(3)
        }
        Spacer()
        if let plan = p.plan {
          VStack(alignment: .trailing, spacing: 8) {
            Text("\(plan.scenes.count) scenes • v\(plan.version)").font(.caption).foregroundStyle(
              .secondary)
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
    }.padding(28).sheet(item: $editing) { scene in
      SceneEditor(p: p, scene: scene).environmentObject(m)
    }
  }
}
struct SceneCard: View {
  let p: Project
  let scene: ProductionScene
  let edit: () -> Void
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
          MediaThumbnail(url: url)
        } else if scene.visual.graphic == nil || !scene.enabled, let r = p.recordings.first,
          let url = p.url(r.proxyPath ?? r.path)
        {
          MediaThumbnail(url: url)
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
        Text(scene.narration).font(.system(size: 13)).lineSpacing(3).lineLimit(4).frame(
          height: 74, alignment: .topLeading)
        if let chapter = scene.chapterTitle {
          Label(chapter, systemImage: "bookmark.fill").font(.system(size: 10, weight: .medium))
            .foregroundStyle(Color.studioAccent).lineLimit(1)
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
  @State private var punch = 1.0
  @State private var enabled = true
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Text("Direct \(scene.id)").font(.title2)
        Spacer()
        Button("Done") { dismiss() }.buttonStyle(QuietButtonStyle())
      }
      Text(scene.narration).font(.callout).foregroundStyle(.secondary).lineLimit(5)
      Picker("Visual", selection: $template) {
        ForEach(["Presenter", "Callout", "ArchitectureFlow", "ChapterTitle"], id: \.self) {
          Text($0).tag($0)
        }
      }
      if template != "Presenter" {
        TextField("Title (up to 100 characters)", text: $title)
        TextField("Subtitle", text: $subtitle)
        if template == "ArchitectureFlow" {
          TextField("Nodes, separated by commas (2–5)", text: $nodes)
          Picker("Failed node", selection: $emphasis) {
            Text("None").tag(-1)
            ForEach(0..<min(5, nodes.split(separator: ",").count), id: \.self) {
              Text("Node \($0 + 1)").tag($0)
            }
          }
        }
      }
      HStack {
        Text("Presenter punch-in")
        Slider(value: $punch, in: 1...1.35)
        Text("\(punch, specifier: "%.2f")×").monospacedDigit().frame(width: 55)
      }
      Toggle("Enable visual instruction (A-roll remains when disabled)", isOn: $enabled)
      if let a = p.assets?.last(where: { $0.sceneId == scene.id && $0.type == "remotion-render" }) {
        DisclosureGroup("Asset provenance") {
          Text(
            "Asset: \(a.assetId)\nJob: \(a.jobId)\nPlan: v\(a.productionPlanVersion)\nTemplate: \(a.template ?? "—")\nInput: \(a.inputHash)\nOutput: \(a.outputHash)\n\(a.path)"
          ).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).frame(
            maxWidth: .infinity, alignment: .leading)
        }
      }
      Spacer()
      Text(
        "A proposal will show the change before you apply it. Applying creates a new plan version and requires storyboard approval."
      ).font(.caption).foregroundStyle(.secondary)
      HStack {
        Spacer()
        Button("Propose This Change") {
          Task {
            let flowNodes = nodes.split(separator: ",").map {
              $0.trimmingCharacters(in: .whitespaces)
            }
            let params: [String: Any] =
              template == "ArchitectureFlow"
              ? [
                "title": title, "subtitle": subtitle,
                "nodes": Array(flowNodes.prefix(6)),
                "emphasis": template == "ArchitectureFlow" ? emphasis : -1,
              ]
              : ["title": title, "subtitle": subtitle]
            let visual: [String: Any] =
              template == "Presenter"
              ? [
                "type": "presenter", "description": "Presenter carries the explanation.",
                "graphic": NSNull(),
              ]
              : [
                "type": "graphic", "description": title,
                "graphic": [
                  "engine": "remotion", "template": template, "templateVersion": "1.0.0",
                  "parameters": params,
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
          m.busy || (template != "Presenter" && title.isEmpty))
      }
    }.padding(28).frame(width: 650, height: 600).textFieldStyle(.roundedBorder).onAppear {
      template = scene.visual.graphic?.template ?? "Presenter"
      title = scene.visual.graphic?.parameters.title ?? ""
      subtitle = scene.visual.graphic?.parameters.subtitle ?? ""
      nodes =
        scene.visual.graphic?.parameters.nodes?.joined(separator: ", ")
        ?? "Requests, Service, Database"
      emphasis = scene.visual.graphic?.parameters.emphasis ?? -1
      punch = scene.camera.punchIn
      enabled = scene.enabled
    }
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
            Button("Review Rough Cut") { m.tab = "Review" }.buttonStyle(QuietButtonStyle())
            Button("Reveal QA Report") { m.reveal(p.url(build.qaPath)) }.buttonStyle(
              QuietButtonStyle())
            Button("Reveal Resolve Export") { m.reveal(p.url(build.exportPath)) }.buttonStyle(
              QuietButtonStyle())
          }
        }
        CostView(p: p)
      }.padding(28)
    }
  }
}
