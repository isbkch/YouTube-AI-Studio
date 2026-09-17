import AVKit
import Combine
import SwiftUI

struct ReviewView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @State private var player: AVPlayer?
  @State private var request = ""
  @State private var sceneID = ""
  @State private var range = ""
  @State private var preset = "H.264 Master"
  @State private var macro = ""
  var previewURL: URL? { p.latestBuild.flatMap { p.url($0.previewPath) } }
  var body: some View {
    HSplitView {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if let player {
            NativePlayer(player: player).aspectRatio(16 / 9, contentMode: .fit).clipShape(
              RoundedRectangle(cornerRadius: 10))
            PlaybackControls(player: player)
          } else {
            VStack(spacing: 16) {
              Image(systemName: "play.rectangle").font(.system(size: 50, weight: .ultraLight))
              Text("Build a rough cut to preview it here.")
            }.foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 300).studioCard(
              cornerRadius: 12)
          }
          if let build = p.latestBuild {
            HStack {
              Text("Rough cut v\(build.planVersion)").font(.headline)
              Spacer()
              Text(timestamp(Double(p.plan?.durationFrames ?? 0) / Double(p.plan?.frameRate ?? 30)))
                .font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            }
            if build.planVersion != p.plan?.version {
              Text(
                "This preview is from an earlier plan. Approve the current storyboard and rebuild to see the revision."
              ).font(.caption).foregroundStyle(.orange)
            }
            HStack {
              Button("Reveal Preview") { m.reveal(p.url(build.previewPath)) }.buttonStyle(
                QuietButtonStyle())
              Button("Resolve Export…") { m.reveal(p.url(build.exportPath)) }.buttonStyle(
                QuietButtonStyle())
              Button("Open in Resolve") { Task { await m.openResolve() } }.buttonStyle(
                QuietButtonStyle()
              ).disabled(m.busy || p.currentBuild == nil)
            }
            Button("Approve Rough Cut v\(build.planVersion)") {
              Task {
                await m.perform(
                  "roughCut.approve", label: "Rough-cut approval",
                  params: ["version": build.planVersion])
              }
            }.buttonStyle(PrimaryActionButtonStyle()).disabled(
              m.busy || p.currentBuild == nil || p.status != "AWAITING_ROUGH_CUT_APPROVAL")
          }
          if let a = p.roughCutApproval {
            Label(
              "Rough cut v\(a.version) approved. Continue final finishing below or in Resolve.",
              systemImage: "checkmark.seal"
            ).foregroundStyle(Color.studioSuccess).font(.caption)
          }
          QAReportView(p: p)
          if p.roughCutApproval != nil { FinalRenderView(p: p, preset: $preset, macro: $macro) }
          PublishingView(p: p)
          Text(
            "Review pacing, factual accuracy, audio, and flagged visuals. Automated QA checks decode, timing, sampled frames and generated stills; it does not approve creative choices."
          ).font(.caption).foregroundStyle(.secondary)
          if let plan = p.plan {
            Text("Jump to scene").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 105))]) {
              ForEach(plan.scenes) { s in
                Button {
                  sceneID = s.id
                  player?.seek(
                    to: CMTime(
                      seconds: Double(s.startFrame) / Double(plan.frameRate),
                      preferredTimescale: 600))
                } label: {
                  VStack(spacing: 4) {
                    Text(s.id)
                    Text(timestamp(Double(s.startFrame) / Double(plan.frameRate))).foregroundStyle(
                      .secondary)
                  }.font(.caption).frame(maxWidth: .infinity).padding(10)
                }.buttonStyle(QuietButtonStyle())
              }
            }
          }
        }.padding(25)
      }.frame(minWidth: 500)
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          HStack {
            Image(systemName: "sparkles").foregroundStyle(Color.studioAccent)
            Text("DIRECTOR").font(.system(size: 12, weight: .semibold)).tracking(2)
            Spacer()
            Text(m.provider.uppercased()).font(.system(size: 9, design: .monospaced))
              .foregroundStyle(.secondary)
          }
          Text("A proposal first. A focused rebuild after.").studioHeading(18)
          if m.provider == "mock" {
            Text(
              "Mock mode proposes a simple return to presenter footage. Select OpenAI in Settings for natural-language editorial interpretation, or edit a scene in the storyboard."
            ).font(.caption).foregroundStyle(.secondary)
          }
          Picker("Scene", selection: $sceneID) {
            ForEach(p.plan?.scenes ?? []) { s in Text(s.id).tag(s.id) }
          }
          TextField("What should change?", text: $request, axis: .vertical).lineLimit(3...6)
            .textFieldStyle(.roundedBorder)
          Button("Propose Revision") {
            Task {
              await m.perform(
                "revision.propose", label: "Director proposal",
                params: ["request": request, "sceneId": sceneID])
              request = ""
            }
          }.buttonStyle(PrimaryActionButtonStyle()).disabled(
            m.busy || request.trimmingCharacters(in: .whitespaces).isEmpty || p.plan == nil)
          Divider()
          Text("Range revision").font(.headline)
          Text(
            "Scope a change to a stretch of the timeline you just watched, e.g. 3:42-4:10."
          ).font(.caption).foregroundStyle(.secondary)
          TextField("3:42-4:10", text: $range).textFieldStyle(.roundedBorder).font(
            .system(size: 12, design: .monospaced))
          Button("Propose Range Revision") {
            Task {
              await m.proposeRange(range, request: request)
              range = ""
              request = ""
            }
          }.buttonStyle(QuietButtonStyle()).disabled(
            m.busy || range.trimmingCharacters(in: .whitespaces).isEmpty
              || request.trimmingCharacters(in: .whitespaces).isEmpty || p.latestBuild == nil)
          Divider()
          ForEach(p.revisions.reversed()) { r in
            VStack(alignment: .leading, spacing: 12) {
              Text(r.patch.originatingRequest).font(.headline)
              Text(r.patch.rationale).font(.caption).foregroundStyle(.secondary)
              Text(
                "v\(r.patch.previousVersion) → v\(r.patch.resultingVersion) · \(r.patch.affectedScenes.joined(separator: ", "))"
              ).font(.system(size: 10, design: .monospaced)).foregroundStyle(Color.studioAccent)
              ForEach(r.patch.affectedScenes, id: \.self) { id in
                if let s = p.plan?.scenes.first(where: { $0.id == id }) {
                  Text(
                    "Current \(id): \(s.visual.graphic?.template ?? "Presenter") — \(s.visual.description)"
                  ).font(.caption).foregroundStyle(.secondary)
                }
              }
              DisclosureGroup("Proposed operations") {
                ForEach(Array(r.patch.operations.enumerated()), id: \.offset) { _, op in
                  Text(op.pretty).font(.system(size: 10, design: .monospaced)).textSelection(
                    .enabled
                  ).frame(maxWidth: .infinity, alignment: .leading)
                }
              }
              if r.status == "PROPOSED" {
                HStack {
                  Button("Apply Proposal") {
                    Task {
                      await m.perform(
                        "revision.decide", label: "Revision applied",
                        params: ["patchId": r.id, "apply": true])
                    }
                  }.buttonStyle(PrimaryActionButtonStyle()).disabled(
                    m.busy || r.patch.previousVersion != p.plan?.version)
                  Button("Reject") {
                    Task {
                      await m.perform(
                        "revision.decide", label: "Revision rejected",
                        params: ["patchId": r.id, "apply": false])
                    }
                  }.buttonStyle(QuietButtonStyle()).disabled(m.busy)
                }
              } else {
                Text(r.status.capitalized).font(.caption).foregroundStyle(.secondary)
              }
            }.padding(15).studioCard(cornerRadius: 11)
          }
          if p.plans.count > 1 {
            Button("Restore Previous Plan as New Version") {
              Task { await m.perform("plan.undo", label: "Plan restored") }
            }.buttonStyle(QuietButtonStyle()).disabled(m.busy)
          }
        }.padding(24)
      }.frame(minWidth: 300, idealWidth: 340, maxWidth: 430)
    }.task(id: previewURL) {
      if let url = previewURL { player = AVPlayer(url: url) }
      if sceneID.isEmpty { sceneID = p.plan?.scenes.first?.id ?? "" }
      await m.loadQA()
      await m.loadFinalOptions()
    }.onDisappear { player?.pause() }
  }
}

/// Automated visual QA: status, attention list, per-scene verdicts, still gates.
struct QAReportView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  var body: some View {
    if let qa = m.qa {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Image(systemName: qa.status == "PASS" ? "checkmark.shield" : "exclamationmark.shield")
            .foregroundStyle(qa.status == "PASS" ? Color.studioSuccess : .orange)
          Text("Automated QA • \(qa.status)").font(.headline)
          Spacer()
          if let by = qa.visual?.reviewedBy {
            Text(by).font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
          }
        }
        if let attention = qa.attention, !attention.isEmpty {
          Text("Scenes needing attention: \(attention.joined(separator: ", "))")
            .font(.caption).foregroundStyle(.orange)
        }
        ForEach(qa.warnings ?? [], id: \.self) { w in
          Label(w, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(
            .secondary)
        }
        let verdicts = (qa.visual?.scenes ?? []).filter { $0.verdict != "pass" }
        if !verdicts.isEmpty {
          DisclosureGroup("Scene verdicts • \(verdicts.count) flagged") {
            ForEach(verdicts) { v in
              VStack(alignment: .leading, spacing: 3) {
                Text("\(v.sceneId) — \(v.verdict)").font(.system(size: 11, weight: .semibold))
                ForEach(Array(v.findings.enumerated()), id: \.offset) { _, f in
                  Text("• [\(f.severity)] \(f.kind): \(f.evidence)").font(.caption2)
                    .foregroundStyle(.secondary)
                }
              }.padding(.vertical, 2)
            }
          }
        }
        let stills = (qa.visual?.stills ?? []).filter { $0.verdict != "pass" }
        if !stills.isEmpty {
          DisclosureGroup("Generated stills • \(stills.count) flagged") {
            ForEach(stills) { s in
              VStack(alignment: .leading, spacing: 3) {
                Text("\(s.sceneId)/\(s.brollId) — \(s.verdict)").font(
                  .system(size: 11, weight: .semibold))
                ForEach(Array(s.findings.enumerated()), id: \.offset) { _, f in
                  Text("• [\(f.severity)] \(f.kind): \(f.evidence)").font(.caption2)
                    .foregroundStyle(.secondary)
                }
              }.padding(.vertical, 2)
            }
          }
        }
        if let frames = qa.visual?.framesDir, let url = p.url(frames) {
          Button("Reveal Sampled Frames") { m.reveal(url) }.buttonStyle(QuietButtonStyle())
        }
      }.padding(16).studioCard(cornerRadius: 11)
    }
  }
}

/// Headless finishing: preset + optional checked-in Fusion macro, through Resolve.
/// Milestone 5 — packaging proposal, the publication gate and one-shot publish.
struct PublishingView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  private var canPackage: Bool {
    ["READY_TO_RENDER", "AWAITING_PUBLISH_APPROVAL"].contains(p.status)
      && p.finalRender != nil
  }
  private var doc: PackagingDocument? {
    guard let d = m.packaging else { return nil }
    return d.version == (p.packaging?.version ?? 0) ? d : nil
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Image(systemName: "shippingbox").foregroundStyle(Color.studioAccent)
        Text("Packaging & publishing").font(.headline)
        Spacer()
        if let pub = p.publication {
          Label("Published", systemImage: "checkmark.seal.fill")
            .font(.caption).foregroundStyle(Color.studioSuccess)
        }
      }
      if let pub = p.publication {
        VStack(alignment: .leading, spacing: 6) {
          Text(pub.url).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
          Text(
            "Uploaded \(pub.publishedAt) • review visibility in YouTube Studio before going wide."
          )
          .font(.caption2).foregroundStyle(.secondary)
        }
      } else {
        Text(
          "The Packaging Agent proposes titles, thumbnail concepts, the description with chapter timestamps, and upload metadata. Nothing leaves this Mac until you approve a version and publish."
        ).font(.caption).foregroundStyle(.secondary)
        Button(m.provider == "mock" ? "Generate Packaging (mock)" : "Generate Packaging") {
          Task { await m.packageVideo() }
        }.buttonStyle(QuietButtonStyle()).disabled(!canPackage || m.busy)
        if let d = doc { packagingBody(d) }
        if let approval = p.publishApproval, approval.version == (p.packaging?.version ?? 0) {
          Label(
            "Packaging v\(approval.version) approved — publishing uploads exactly this document.",
            systemImage: "checkmark.seal"
          ).font(.caption).foregroundStyle(Color.studioSuccess)
        }
        HStack {
          Button("Approve Packaging v\(p.packaging?.version ?? 1)") {
            Task { await m.approvePackaging(p.packaging?.version ?? 1) }
          }.buttonStyle(QuietButtonStyle()).disabled(
            m.busy || p.status != "AWAITING_PUBLISH_APPROVAL" || doc == nil
              || p.publishApproval?.version == p.packaging?.version)
          Button("Publish to YouTube") { Task { await m.publish() } }
            .buttonStyle(PrimaryActionButtonStyle()).disabled(
              m.busy || p.status != "AWAITING_PUBLISH_APPROVAL"
                || p.publishApproval == nil)
        }
        Text(
          "Uploads run through the local youtubeuploader CLI (installed automatically on first publish; see Settings → Environment); WTS_YOUTUBE_ARGS carries its OAuth flags."
        ).font(.caption2).foregroundStyle(.secondary)
      }
    }.padding(16).studioCard(cornerRadius: 11).task(id: p.packaging?.version) {
      await m.loadPackaging()
    }
  }
  @ViewBuilder private func packagingBody(_ d: PackagingDocument) -> some View {
    Divider()
    VStack(alignment: .leading, spacing: 6) {
      Text("Recommended title").font(.caption).foregroundStyle(.secondary)
      Text(d.packaging.recommendedTitle).font(.headline)
      ForEach(d.packaging.titleCandidates) { c in
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: c.title == d.packaging.recommendedTitle ? "star.fill" : "circle")
            .font(.caption2).foregroundStyle(Color.studioAccent)
          VStack(alignment: .leading, spacing: 2) {
            Text(c.title).font(.caption)
            Text("\(c.angle) — \(c.why)").font(.caption2).foregroundStyle(.secondary)
          }
        }
      }
    }
    VStack(alignment: .leading, spacing: 6) {
      Text("Thumbnail concepts").font(.caption).foregroundStyle(.secondary)
      ForEach(d.packaging.thumbnailConcepts) { c in
        VStack(alignment: .leading, spacing: 2) {
          Text(c.headline).font(.system(size: 13, weight: .semibold))
          Text("\(c.emotionalHook) — \(c.direction)").font(.caption2).foregroundStyle(.secondary)
        }
      }
    }
    if !d.packaging.chapters.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text("Chapters (from the rendered timeline)").font(.caption).foregroundStyle(.secondary)
        ForEach(d.packaging.chapters) { c in
          HStack(spacing: 10) {
            Text(timestamp(Double(c.seconds))).font(.system(size: 11, design: .monospaced))
              .foregroundStyle(Color.studioAccent).frame(width: 52, alignment: .leading)
            Text(c.title).font(.caption)
          }
        }
      }
    }
    VStack(alignment: .leading, spacing: 4) {
      Text(
        "Visibility \(d.packaging.metadata.visibility) • category \(d.packaging.metadata.categoryId) • \(d.packaging.metadata.tags.count) tags"
      ).font(.caption2).foregroundStyle(.secondary)
      ScrollView {
        Text(d.description).font(.system(size: 12)).lineSpacing(4)
          .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
      }.frame(maxHeight: 180)
    }
  }
}

struct FinalRenderView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @Binding var preset: String
  @Binding var macro: String
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Image(systemName: "film").foregroundStyle(Color.studioAccent)
        Text("Finishing").font(.headline)
        Spacer()
      }
      Text(
        "Approving the rough cut starts the final render autonomously: Resolve first, with an automatic FFmpeg fallback when Resolve cannot finish. The pickers below override the engine for a manual re-render."
      ).font(.caption).foregroundStyle(.secondary)
      HStack {
        Picker("Preset", selection: $preset) {
          ForEach(m.finalPresets, id: \.self) { Text($0).tag($0) }
        }
        Picker("Macro", selection: $macro) {
          Text("None").tag("")
          ForEach(m.finalMacros, id: \.self) { Text($0).tag($0) }
        }
      }
      HStack {
        Button("Start Final Render") {
          Task { await m.renderFinal(preset: preset, macro: macro) }
        }.buttonStyle(PrimaryActionButtonStyle()).disabled(
          m.busy || !["READY_TO_RENDER", "AWAITING_PUBLISH_APPROVAL"].contains(p.status))
        if let f = p.finalRender, let url = p.url(f) {
          Label(
            URL(fileURLWithPath: f).lastPathComponent
              + (p.finalRenderEngine.map { " · \($0)" } ?? ""),
            systemImage: "checkmark.seal"
          ).font(.caption).foregroundStyle(Color.studioSuccess)
          Button("Reveal") { m.reveal(url) }.buttonStyle(QuietButtonStyle())
        }
      }
    }.padding(16).studioCard(cornerRadius: 11)
  }
}

struct NativePlayer: NSViewRepresentable {
  let player: AVPlayer
  func makeNSView(context: Context) -> AVPlayerView {
    let view = AVPlayerView()
    view.controlsStyle = .inline
    view.showsFullScreenToggleButton = true
    view.player = player
    return view
  }
  func updateNSView(_ view: AVPlayerView, context: Context) {
    if view.player !== player { view.player = player }
  }
  static func dismantleNSView(_ view: AVPlayerView, coordinator: ()) {
    view.player?.pause()
    view.player = nil
  }
}

struct PlaybackControls: View {
  let player: AVPlayer
  @State private var position = 0.0
  @State private var playing = false
  @State private var seeking = false
  @State private var loadedDuration = 1.0
  private let timer = Timer.publish(every: 0.3, on: .main, in: .common).autoconnect()
  var duration: Double { loadedDuration }
  var body: some View {
    HStack(spacing: 14) {
      Button {
        if player.rate == 0 { player.play() } else { player.pause() }
        playing = player.rate != 0
      } label: {
        Image(systemName: playing ? "pause.fill" : "play.fill")
      }.accessibilityLabel(playing ? "Pause rough cut" : "Play rough cut")
      Text(timestamp(position)).font(.system(.caption, design: .monospaced)).frame(width: 44)
      Slider(value: $position, in: 0...duration) { editing in
        seeking = editing
        if !editing {
          player.seek(
            to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero,
            toleranceAfter: .zero)
        }
      }.accessibilityLabel("Playback position")
      Text(timestamp(duration)).font(.system(.caption, design: .monospaced)).foregroundStyle(
        .secondary)
    }.onReceive(timer) { _ in
      playing = player.rate != 0
      let actualDuration = player.currentItem?.duration.seconds ?? 0
      if actualDuration.isFinite && actualDuration > 0 { loadedDuration = actualDuration }
      if !seeking {
        let time = player.currentTime().seconds
        position = min(duration, time.isFinite ? max(0, time) : 0)
      }
    }
  }
}
