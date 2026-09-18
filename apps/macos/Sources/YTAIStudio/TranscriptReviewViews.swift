import AVKit
import SwiftUI

struct TranscriptReviewPanel: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @State private var showReview = false
  @State private var showHistory = false
  var body: some View {
    HStack(spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text(
          p.pendingTranscriptIssues > 0
            ? "\(p.pendingTranscriptIssues) checks need listening"
            : p.activeTranscriptReviews.isEmpty
              ? "Make every word count" : "Transcript checks complete"
        )
        .font(.headline)
        Text(
          p.activeTranscriptReviews.isEmpty
            ? "Recognize with GPT Transcribe, align words to audio, and review uncertain passages."
            : "Originals and decisions are saved. Existing storyboards keep their transcript version."
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      if !p.transcripts.isEmpty {
        Button("History") { showHistory = true }.buttonStyle(QuietButtonStyle())
      }
      if !p.activeTranscriptReviews.isEmpty {
        Button("Review passages") { showReview = true }.buttonStyle(QuietButtonStyle())
      }
      Menu {
        Button("All recordings") { Task { await m.reviewTranscription() } }
        ForEach(p.recordings) { r in
          Button(r.name) { Task { await m.reviewTranscription(recordingID: r.id) } }
        }
      } label: {
        Label("Transcribe & Review", systemImage: "waveform.badge.magnifyingglass")
      }.disabled(m.busy || !p.transcriptReviewIdle || p.recordings.isEmpty)
    }.padding(16).studioCard(cornerRadius: 12)
      .sheet(isPresented: $showReview) { TranscriptListeningReview(projectID: p.id) }
      .sheet(isPresented: $showHistory) { TranscriptHistoryView(p: p) }
  }
}
struct TranscriptHistoryView: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) var dismiss
  let p: Project
  @State private var history: [Transcript] = []
  @State private var error: String?
  @State private var loading = true
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Transcript history").font(.title2)
        Spacer()
        Button("Done") { dismiss() }
      }
      ScrollView {
        ForEach(Array(history.enumerated()), id: \.offset) { _, transcript in
          DisclosureGroup(
            "\(p.recordings.first { $0.id == transcript.recordingId }?.name ?? "Recording") · \(transcript.model) · \(transcript.revision?.createdAt ?? "Original import")"
          ) {
            ForEach(transcript.segments) { s in
              Text("\(timestamp(s.start))–\(timestamp(s.end))  \(s.text)").frame(
                maxWidth: .infinity, alignment: .leading
              ).textSelection(.enabled).padding(.vertical, 3)
            }
          }.padding(.vertical, 6)
        }
      }
    }.padding(24).frame(width: 850, height: 600)
      .overlay {
        if loading { ProgressView("Loading transcript history") }
        if let error { Text(error).foregroundStyle(.red).padding(24) }
      }
      .task {
        do { history = try await m.runtime.call("transcript.history", ["projectId": p.id]) } catch {
          self.error = error.localizedDescription
        }
        loading = false
      }
  }
}
struct TranscriptListeningReview: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) var dismiss
  let projectID: String
  @State private var player: AVPlayer?
  @State private var playingID: String?
  @State private var showResolved = false
  @State private var editingIssue: String?
  @State private var correctionText = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Listen, then decide").font(.title2)
        Spacer()
        Toggle("Show resolved", isOn: $showResolved).toggleStyle(.switch)
        Button("Done") { dismiss() }
      }
      Text(
        "The script provides context. The recording is the evidence. Accept uses the independently recognized, audio-aligned text below."
      )
      .font(.callout).foregroundStyle(.secondary)
      if let error = m.error { Text(error).font(.callout).foregroundStyle(.red) }
      if let player { VideoPlayer(player: player).frame(height: 220) }
      ScrollView {
        if let p = m.project, p.id == projectID {
          ForEach(p.activeTranscriptReviews) { report in
            if let r = p.recordings.first(where: { $0.id == report.recordingId }) {
              VStack(alignment: .leading, spacing: 12) {
                Text(r.name).font(.headline)
                ForEach(report.issues.filter { showResolved || $0.status == "pending" }) { issue in
                  VStack(alignment: .leading, spacing: 8) {
                    HStack {
                      Text("\(timestamp(issue.start))–\(timestamp(issue.end)) · \(issue.kind)")
                        .font(.caption).foregroundStyle(.secondary)
                      Spacer()
                      Text(issue.status.replacingOccurrences(of: "-", with: " ")).font(.caption)
                      Button(playingID == issue.id ? "Replay" : "Play passage") {
                        play(p: p, r: r, issue: issue)
                      }
                    }
                    Text(issue.reason).font(.callout)
                    Text("Current: \(issue.originalText)").textSelection(.enabled)
                    if let verification = issue.verification {
                      Text("Audio recheck: \(verification.text)").textSelection(.enabled)
                      if issue.proposed == nil {
                        Text(
                          "No reliable replacement timing. Listen before keeping this passage, or run another review."
                        ).font(.caption).foregroundStyle(.secondary)
                      }
                    }
                    if issue.status == "pending" {
                      HStack {
                        Button("Edit wording") {
                          editingIssue = issue.id
                          correctionText =
                            issue.proposed?.map(\.text).joined(separator: " ") ?? issue.originalText
                        }
                        Button("Keep current wording") { decide(report, issue, "keep") }
                        Button("Accept audio recheck") { decide(report, issue, "accept") }
                          .disabled(issue.proposed?.isEmpty != false)
                      }.disabled(m.busy || !p.transcriptReviewIdle)
                      if editingIssue == issue.id {
                        TextEditor(text: $correctionText).frame(height: 70).border(
                          Color.secondary.opacity(0.3))
                        HStack {
                          Text("Enter exactly what you hear. Word timings will be checked again.")
                            .font(.caption).foregroundStyle(.secondary)
                          Spacer()
                          Button("Align & save correction") { correct(report, issue) }
                            .disabled(
                              m.busy
                                || correctionText.trimmingCharacters(in: .whitespacesAndNewlines)
                                  .isEmpty
                            )
                        }
                      }
                    }
                  }.padding(14).studioCard(cornerRadius: 10)
                }
              }.padding(.bottom, 12)
            }
          }
          if p.pendingTranscriptIssues == 0 && !showResolved {
            Text("No passages awaiting a decision. Show resolved to inspect the review findings.")
              .foregroundStyle(.secondary)
          }
        }
      }
    }.padding(24).frame(width: 900, height: 760)
      .onDisappear {
        player?.pause()
        player = nil
      }
  }
  private func play(p: Project, r: Recording, issue: TranscriptIssue) {
    guard let url = p.url(r.path) else { return }
    player?.pause()
    let item = AVPlayerItem(url: url)
    item.forwardPlaybackEndTime = CMTime(
      seconds: min(r.duration, issue.end + 0.5), preferredTimescale: 600)
    let next = AVPlayer(playerItem: item)
    next.seek(
      to: CMTime(seconds: max(0, issue.start - 0.5), preferredTimescale: 600),
      toleranceBefore: .zero, toleranceAfter: .zero)
    player = next
    playingID = issue.id
    next.play()
  }
  private func correct(_ report: TranscriptionReview, _ issue: TranscriptIssue) {
    player?.pause()
    Task {
      if await m.perform(
        "transcript.correct", label: "Aligning correction",
        params: [
          "projectId": projectID, "reviewId": report.id, "issueId": issue.id,
          "expectedHash": report.candidateHash, "text": correctionText,
        ])
      {
        editingIssue = nil
      }
    }
  }
  private func decide(_ report: TranscriptionReview, _ issue: TranscriptIssue, _ action: String) {
    player?.pause()
    Task {
      _ = await m.perform(
        "transcript.decide", label: "Transcript decision",
        params: [
          "projectId": projectID, "reviewId": report.id, "issueId": issue.id, "action": action,
          "expectedHash": report.candidateHash,
        ])
    }
  }
}
