import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct OverviewView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        VStack(alignment: .leading, spacing: 10) {
          Text("Your direction. A deliberate production.").font(.system(size: 27, weight: .medium))
          Text(
            p.description.isEmpty
              ? "Build a clear explanation, then decide where visuals help." : p.description
          ).foregroundStyle(.secondary).lineSpacing(5)
        }
        HStack(spacing: 14) {
          GateCard(
            number: "01", title: "Script approval",
            detail: p.scriptApproval == nil
              ? "Your words, before production." : "Version \(p.scriptApproval!.version) approved",
            complete: p.scriptApproval != nil)
          GateCard(
            number: "02", title: "Rough-cut approval",
            detail: p.roughCutApproval == nil
              ? "Review the edit and ask for changes."
              : "Version \(p.roughCutApproval!.version) approved",
            complete: p.roughCutApproval != nil)
          GateCard(
            number: "03", title: "Publication approval", detail: "Publishing is outside this MVP.",
            complete: false)
        }
        HStack(spacing: 20) {
          Metric(value: "\(p.recordings.count)", label: "A-roll recordings")
          Metric(value: "\(p.plan?.scenes.count ?? 0)", label: "Planned scenes")
          Metric(
            value:
              "\(p.assets?.filter { $0.type == "remotion-render" && $0.productionPlanVersion == p.plan?.version }.count ?? 0)",
            label: "Current graphics")
          Metric(value: "\(p.builds.count)", label: "Rough-cut versions")
        }
        VStack(alignment: .leading, spacing: 16) {
          Text("Production path").font(.headline)
          Text("Approved script → A-roll → Transcript → Storyboard → Assets → Rough cut").font(
            .callout
          ).foregroundStyle(.secondary)
          HStack {
            Button("Open Script") { m.tab = "Script" }
            Button("Review Storyboard") { m.tab = "Storyboard" }.disabled(p.plan == nil)
            Button("Watch Rough Cut") { m.tab = "Review" }.disabled(p.latestBuild == nil)
          }
        }.padding(22).frame(maxWidth: .infinity, alignment: .leading).background(
          Color.studioSurface, in: RoundedRectangle(cornerRadius: 14))
        CostView(p: p)
      }.padding(30)
    }
  }
}
struct GateCard: View {
  let number: String
  let title: String
  let detail: String
  let complete: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack {
        Text(number).font(.system(size: 14, design: .monospaced)).foregroundStyle(.secondary)
        Spacer()
        Image(systemName: complete ? "checkmark.circle.fill" : "circle.dashed").foregroundStyle(
          complete ? Color.studioAccent : .secondary)
      }
      Text(title).font(.headline)
      Text(detail).font(.caption).foregroundStyle(.secondary).frame(height: 32, alignment: .top)
    }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(
      Color.studioSurface, in: RoundedRectangle(cornerRadius: 14))
  }
}
struct Metric: View {
  let value: String
  let label: String
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(value).font(.system(size: 30, weight: .light, design: .rounded))
      Text(label).font(.caption).foregroundStyle(.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
struct CostView: View {
  let p: Project
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Usage & provenance").font(.headline)
      HStack {
        Text("\(p.usage.reduce(0) { $0 + $1.inputTokens + $1.outputTokens }) tokens")
        Text("•")
        Text(
          p.usage.contains { $0.costUSD == nil }
            ? "API cost unpriced · see provider billing"
            : String(format: "$%.2f API total", p.usage.reduce(0) { $0 + ($1.costUSD ?? 0) }))
        Text("•")
        Text("\(timestamp((p.assets ?? []).reduce(0) { $0 + $1.renderMs } / 1000)) local rendering")
      }.font(.caption).foregroundStyle(.secondary)
      Text(
        "Each generated asset records its scene, instruction, template, hashes, and job. Preferences change only when you edit them."
      ).font(.caption).foregroundStyle(.secondary)
    }
  }
}
struct ScriptView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @State private var draft = ""
  private var editable: Bool {
    ["IDEA", "SCRIPTING", "AWAITING_SCRIPT_APPROVAL", "READY_TO_RECORD"].contains(p.status)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        VStack(alignment: .leading, spacing: 6) {
          Text("The script is the creative contract.").font(.title2)
          Text(
            p.scriptApproval.map {
              "Approved version \($0.version). Every saved change requires approval."
            } ?? "Save a version, review it, and approve it before importing A-roll."
          ).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Import Text…") {
          if let url = m.chooseFile(types: [.plainText]) {
            draft = (try? String(contentsOf: url, encoding: .utf8)) ?? draft
          }
        }.disabled(!editable || m.busy)
      }
      TextEditor(text: $draft).font(.system(size: 16)).lineSpacing(7).scrollContentBackground(
        .hidden
      ).padding(18).background(Color.studioSurface, in: RoundedRectangle(cornerRadius: 12))
        .disabled(!editable)
      HStack {
        Text(
          "\(draft.split { $0.isWhitespace || $0.isNewline }.count) words • \(p.scripts.count) saved versions"
        ).font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button("Save New Version") {
          Task { await m.perform("script.save", label: "Script saved", params: ["text": draft]) }
        }.disabled(
          !editable || m.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || draft == p.scripts.last?.text)
        Button("Approve Script v\(p.scripts.last?.version ?? 1)") {
          Task {
            await m.perform(
              "script.approve", label: "Script approval",
              params: ["version": p.scripts.last?.version ?? 1])
          }
        }.buttonStyle(.borderedProminent).tint(.studioAccent).foregroundStyle(.black).disabled(
          m.busy || p.status != "AWAITING_SCRIPT_APPROVAL" || draft != p.scripts.last?.text)
      }
    }.padding(28).task(id: p.scripts.last?.version) { draft = p.scripts.last?.text ?? "" }
  }
}
struct MediaView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @State private var targeted = false
  private var canImport: Bool {
    ["READY_TO_RECORD", "MEDIA_IMPORTED"].contains(p.status) && p.scriptApproval != nil
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        Text("A-roll, safely on disk.").font(.title2)
        VStack(spacing: 14) {
          Image(systemName: "square.and.arrow.down").font(.system(size: 34, weight: .light))
            .foregroundStyle(Color.studioAccent)
          Text(
            p.recordings.isEmpty
              ? "Drop your talking-head recordings here"
              : "Drop additional clips any time before planning"
          ).font(.headline)
          Text(
            p.scriptApproval == nil
              ? "Approve the script first."
              : "Select or drop several clips at once; each is imported in order. Originals are preserved."
          ).font(.caption).foregroundStyle(.secondary)
          Button("Choose A-roll…") { Task { await m.importVideo() } }.disabled(!canImport || m.busy)
        }.frame(maxWidth: .infinity).padding(45).background(
          targeted ? Color.studioAccent.opacity(0.08) : Color.studioSurface,
          in: RoundedRectangle(cornerRadius: 14)
        ).overlay(
          RoundedRectangle(cornerRadius: 14).strokeBorder(
            Color.studioAccent.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [6, 5]))
        )
        .dropDestination(for: URL.self) { urls, _ in
          guard !m.busy, canImport, !urls.isEmpty else { return false }
          Task { await m.importVideo(urls) }
          return true
        } isTargeted: {
          targeted = $0
        }
        ForEach(p.recordings) { r in
          HStack(spacing: 22) {
            if let url = p.url(r.proxyPath ?? r.path) {
              MediaThumbnail(url: url).frame(width: 225, height: 127).clipShape(
                RoundedRectangle(cornerRadius: 9))
            }
            VStack(alignment: .leading, spacing: 10) {
              Text(r.name).font(.headline)
              Text(
                "\(timestamp(r.duration))  •  \(r.width) × \(r.height)  •  \(r.codec.uppercased())  •  \(r.frameRate, specifier: "%.2f") fps"
              ).font(.caption).foregroundStyle(.secondary)
              Text("Proxy: \(r.proxyStatus.replacingOccurrences(of: "_", with: " ").capitalized)")
                .foregroundStyle(Color.studioAccent).font(.caption)
              Text(
                r.hasAudio
                  ? "Audio track detected" : "No audio track · import a transcript manually"
              ).font(.caption).foregroundStyle(.secondary)
              Button("Reveal Imported Original") { m.reveal(p.url(r.path)) }
            }
            Spacer()
          }.padding(20).background(Color.studioSurface, in: RoundedRectangle(cornerRadius: 12))
        }
        if !p.recordings.isEmpty { Button("Continue to Transcript →") { m.tab = "Transcript" } }
      }.padding(30)
    }
  }
}
struct TranscriptView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack {
        VStack(alignment: .leading, spacing: 6) {
          Text("Words, anchored to each clip.").font(.title2)
          Text(
            p.recordings.isEmpty
              ? "Import A-roll first."
              : "\(p.recordings.count) clip(s) • \(p.pendingRecordings.count) still need a transcript • timestamps are relative to each clip"
          ).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Import Final Cut Analysis…") {
          Task { await m.importFCPTranscripts() }
        }.disabled(p.status != "MEDIA_IMPORTED" || m.busy)
        Button("Load Transcript…") { Task { await m.loadTranscript() } }.disabled(
          p.status != "MEDIA_IMPORTED" || m.busy)
        Button(m.provider == "mock" ? "Mock Transcribe" : "Transcribe with OpenAI") {
          Task { await m.perform("transcript.generate", label: "Transcription") }
        }.disabled(
          p.status != "MEDIA_IMPORTED" || m.busy || p.pendingRecordings.isEmpty)
      }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(p.recordings) { r in
            if let t = p.transcript(for: r) {
              TranscriptSectionHeader(
                recording: r, detail: "\(t.provider) / \(t.model)")
              ForEach(t.segments) { s in segmentRow(s) }
            } else {
              TranscriptSectionHeader(recording: r, detail: "Awaiting transcript")
              Text(
                "Load a timestamped JSON for this clip, or transcribe all pending clips."
              ).font(.caption).foregroundStyle(.secondary).padding(.vertical, 14)
            }
            Divider().opacity(0.4)
          }
        }
      }
      if p.transcripts.isEmpty {
        Text(
          "A transcript must contain ordered, non-overlapping segments with start/end seconds and text, and may name its recordingId. Final Cut speech analysis is imported word-level with Import Final Cut Analysis… See examples/redundancy/transcript.json."
        ).font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 160)
      }
      if let draft = m.aroll {
        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text("A-roll draft").font(.headline)
            Spacer()
            Text(
              "\(draft.stats.groups) scene(s) • \(String(format: "%.0f", draft.stats.keptSeconds))s kept • \(draft.stats.droppedSentences) sentence(s) dropped • \(draft.stats.suggestedGraphics) graphic suggestion(s)"
            ).font(.caption).foregroundStyle(.secondary)
          }
          ForEach(draft.scenes) { s in
            HStack(alignment: .top, spacing: 14) {
              Text(timestamp(s.start) + "–" + timestamp(s.end)).font(
                .system(size: 11, design: .monospaced)
              ).foregroundStyle(Color.studioAccent).frame(width: 104, alignment: .leading)
              VStack(alignment: .leading, spacing: 3) {
                Text(String(s.narration.prefix(160))).font(.caption).lineLimit(2)
                if let g = s.suggestedGraphic {
                  Text("\(g.template) — \(g.reason)").font(.caption2).foregroundStyle(
                    Color.studioAccent)
                }
              }.frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          ForEach(draft.dropped) { d in
            Text("Dropped: \(String(d.text.prefix(100)))").font(.caption2).foregroundStyle(
              .secondary)
          }
          Text(
            "Deterministic draft from script↔take alignment; the Director plan supersedes it."
          ).font(.caption2).foregroundStyle(.secondary)
        }.padding(16).background(Color.studioSurface, in: RoundedRectangle(cornerRadius: 12))
      }
      HStack {
        Button("Draft A-Roll Cut") { Task { await m.draftAroll() } }.disabled(
          !p.pendingRecordings.isEmpty || m.busy)
        Spacer()
        Button("Import Plan…") { Task { await m.importPlan() } }.disabled(
          !p.pendingRecordings.isEmpty || m.busy || p.status != "MEDIA_IMPORTED")
        Button("Generate Storyboard") {
          Task {
            await m.perform("plan.generate", label: "Director planning")
            m.tab = "Storyboard"
          }
        }.buttonStyle(.borderedProminent).tint(.studioAccent).foregroundStyle(.black).disabled(
          !p.pendingRecordings.isEmpty || m.busy || p.status != "MEDIA_IMPORTED")
      }
    }.padding(28)
  }
  private func segmentRow(_ s: Segment) -> some View {
    HStack(alignment: .top, spacing: 22) {
      Text(timestamp(s.start) + "–" + timestamp(s.end)).font(
        .system(size: 11, design: .monospaced)
      ).foregroundStyle(Color.studioAccent).frame(width: 104, alignment: .leading)
      Text(s.text).font(.system(size: 15)).lineSpacing(5).frame(
        maxWidth: .infinity, alignment: .leading)
    }.padding(.vertical, 20)
  }
}
struct TranscriptSectionHeader: View {
  let recording: Recording
  let detail: String
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "film").foregroundStyle(.secondary)
      Text(recording.name).font(.headline)
      Text(detail).font(.caption).foregroundStyle(.secondary)
      Spacer()
    }.padding(.top, 22).padding(.bottom, 6)
  }
}
