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
            }.foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 300).background(
              Color.studioSurface, in: RoundedRectangle(cornerRadius: 12))
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
              Button("Reveal Preview") { m.reveal(p.url(build.previewPath)) }
              Button("Resolve Export…") { m.reveal(p.url(build.exportPath)) }
              Button("Open in Resolve") { Task { await m.openResolve() } }.disabled(
                m.busy || p.currentBuild == nil)
            }
            Button("Approve Rough Cut v\(build.planVersion)") {
              Task {
                await m.perform(
                  "roughCut.approve", label: "Rough-cut approval",
                  params: ["version": build.planVersion])
              }
            }.buttonStyle(.borderedProminent).tint(.studioAccent).foregroundStyle(.black).disabled(
              m.busy || p.currentBuild == nil || p.status != "AWAITING_ROUGH_CUT_APPROVAL")
          }
          if let a = p.roughCutApproval {
            Label(
              "Rough cut v\(a.version) approved. Continue final finishing in Resolve.",
              systemImage: "checkmark.seal"
            ).foregroundStyle(Color.studioAccent).font(.caption)
          }
          Text(
            "Review pacing, factual accuracy, audio, and text fit. Technical QA checks decode, timing and asset completeness; it does not approve creative choices."
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
                }.buttonStyle(.bordered)
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
          Text("A proposal first. A focused rebuild after.").font(.title3)
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
          }.disabled(
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
          }.disabled(
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
                  }.disabled(m.busy || r.patch.previousVersion != p.plan?.version)
                  Button("Reject") {
                    Task {
                      await m.perform(
                        "revision.decide", label: "Revision rejected",
                        params: ["patchId": r.id, "apply": false])
                    }
                  }.disabled(m.busy)
                }
              } else {
                Text(r.status.capitalized).font(.caption).foregroundStyle(.secondary)
              }
            }.padding(15).background(Color.studioSurface, in: RoundedRectangle(cornerRadius: 11))
          }
          if p.plans.count > 1 {
            Button("Restore Previous Plan as New Version") {
              Task { await m.perform("plan.undo", label: "Plan restored") }
            }.disabled(m.busy).font(.caption)
          }
        }.padding(24)
      }.frame(minWidth: 300, idealWidth: 340, maxWidth: 430)
    }.task(id: previewURL) {
      if let url = previewURL { player = AVPlayer(url: url) }
      if sceneID.isEmpty { sceneID = p.plan?.scenes.first?.id ?? "" }
    }.onDisappear { player?.pause() }
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
