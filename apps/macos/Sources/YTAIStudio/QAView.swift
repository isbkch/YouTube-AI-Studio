import AppKit
import SwiftUI

/// The dedicated Visual QA tab. Every build ends with an automated QA pass —
/// decode/duration/asset verification, audio and anomaly filters, sampled-frame
/// vision review and generated-still gates — and this tab makes that report a
/// first-class workspace instead of a job card at the bottom of Production.
struct VisualQAView: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @State private var attentionOnly = false

  private var qa: QAReport? { m.qa }
  private var plan: Plan? { p.plan }
  private var fps: Double { Double(plan?.frameRate ?? 30) }
  private var previewURL: URL? { p.latestBuild.flatMap { p.url($0.previewPath) } }
  /// Re-load the report when the project or its latest build changes; a
  /// finishing build swaps in a new qaPath, so the tab updates itself.
  private var qaKey: String { "\(m.selectedID ?? "")|\(p.latestBuild?.qaPath ?? "")" }

  /// Jobs arrive newest-first; the first job's run identifies the latest run.
  private var currentRunJobs: [Job] {
    guard let run = p.jobs?.first?.runId else { return [] }
    return (p.jobs ?? []).filter { $0.runId == run }
  }
  private var qaJob: Job? { currentRunJobs.first { $0.type == "qa" } }
  private var building: Bool { currentRunJobs.contains { $0.status != "COMPLETE" } }
  private var isStale: Bool {
    guard qa != nil, !building else { return false }
    return p.latestBuild?.planVersion != plan?.version
  }

  var body: some View {
    Group {
      if p.latestBuild == nil && qa == nil && !building {
        emptyState
      } else {
        HSplitView {
          ScrollView {
            VStack(alignment: .leading, spacing: 20) {
              if building { buildingBanner }
              if isStale { staleBanner }
              if let qa {
                hero(qa)
                warningsCard(qa)
                sceneVerdicts(qa)
                stillsSection(qa)
              } else if !building {
                missingReport
              }
            }.padding(25)
          }.frame(minWidth: 480)
          ScrollView {
            if let qa {
              Sidebar(qa: qa, p: p)
            } else {
              VStack(alignment: .leading, spacing: 16) {
                QASectionLabel("While you wait")
                Text(
                  "The QA pass runs last in the build. It verifies decode and asset completeness, filters for black and frozen frames, analyzes the mix, and writes the report when it finishes."
                ).font(.caption).foregroundStyle(.secondary).lineSpacing(3)
              }
            }
          }.frame(minWidth: 290, idealWidth: 330, maxWidth: 400)
        }.task(id: qaKey) { await m.loadQA() }
      }
    }
  }

  // MARK: - States

  private var emptyState: some View {
    VStack(spacing: 18) {
      Image(systemName: "checkmark.shield").font(.system(size: 50, weight: .ultraLight))
        .foregroundStyle(Color.studioAccent)
      Text("QA runs at the end of every build.").studioHeading(22)
      Text(
        "Production verifies decode, duration and asset completeness, filters for black and frozen frames, analyzes the mix, and samples one frame per scene for vision review. The full report lands here."
      ).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        .frame(maxWidth: 460)
      Button("Open Production") { m.tab = "Production" }.buttonStyle(QuietButtonStyle())
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var buildingBanner: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let job = qaJob {
        HStack(spacing: 14) {
          Image(systemName: "gearshape.2").foregroundStyle(Color.studioAccent)
          VStack(alignment: .leading, spacing: 7) {
            Text(job.label).font(.headline)
            ProgressView(value: job.progress).tint(.studioAccent)
            if let last = job.logs.last {
              Text(last).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                .lineLimit(1)
            }
          }
          Spacer()
          Text(job.status).font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(.secondary)
        }
      } else {
        Label(
          "A build is running; the QA pass completes the pipeline and its report appears here.",
          systemImage: "gearshape.2"
        ).font(.caption).foregroundStyle(.secondary)
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 12)
  }

  private var staleBanner: some View {
    HStack(alignment: .top) {
      Image(systemName: "clock.badge.exclamationmark").foregroundStyle(.orange)
      Text(
        "This report covers rough cut v\(p.latestBuild?.planVersion ?? 0); the current plan is v\(plan?.version ?? 0). Rebuild to re-run QA against the revision."
      ).font(.caption).foregroundStyle(.orange).lineSpacing(2)
      Spacer()
      Button("Rebuild") {
        m.tab = "Production"
        Task { await m.perform("build", label: "Production") }
      }.buttonStyle(QuietButtonStyle()).disabled(
        m.busy || p.planApproval?.version != plan?.version)
    }.padding(14).background(
      Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 11))
  }

  private var missingReport: some View {
    VStack(spacing: 14) {
      Image(systemName: "file.question").font(.system(size: 34, weight: .ultraLight))
        .foregroundStyle(.secondary)
      Text("The QA report for this build could not be loaded.").font(.headline)
      if let build = p.latestBuild {
        Button("Reveal Preview") { m.reveal(p.url(build.previewPath)) }.buttonStyle(
          QuietButtonStyle())
      }
    }.frame(maxWidth: .infinity, minHeight: 220).studioCard(cornerRadius: 12).padding(.top, 6)
  }

  // MARK: - Verdict hero

  private func hero(_ qa: QAReport) -> some View {
    let scenes = qa.visual?.scenes ?? []
    let stills = qa.visual?.stills ?? []
    let flagged = flaggedSceneIds(qa)
    let passed = scenes.count - scenes.filter { $0.verdict != "pass" }.count
    let meta = qa.metadata
    let resolution =
      meta.flatMap { meta -> String? in
        guard let width = meta.width, let height = meta.height else { return nil }
        return "\(width)×\(height)"
      } ?? "—"
    return VStack(alignment: .leading, spacing: 20) {
      HStack(alignment: .center, spacing: 16) {
        Image(
          systemName: qa.status == "PASS"
            ? "checkmark.shield.fill" : "exclamationmark.shield.fill"
        ).font(.system(size: 38, weight: .ultraLight)).foregroundStyle(
          qa.status == "PASS" ? Color.studioSuccess : .orange
        )
        VStack(alignment: .leading, spacing: 5) {
          Text(qa.status == "PASS" ? "Passed automated QA" : "Needs attention").studioHeading(24)
          Text(caption(qa)).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Open Review") { m.tab = "Review" }.buttonStyle(PrimaryActionButtonStyle())
      }
      HStack(spacing: 20) {
        Metric(value: timestamp(meta?.duration ?? 0), label: "Duration")
        Metric(
          value: resolution,
          label: meta.map { "\(fpsLabel($0.frameRate)) fps · \($0.codec ?? "video")" }
            ?? "Resolution"
        )
        Metric(value: meta.map { "\($0.frames ?? 0)" } ?? "—", label: "Frames")
        Metric(
          value: scenes.isEmpty ? "—" : "\(passed)/\(scenes.count)", label: "Scenes passed")
        Metric(
          value: stills.isEmpty
            ? "—"
            : "\(stills.count - stills.filter { $0.verdict != "pass" }.count)/\(stills.count)",
          label: "Stills passed")
      }
      if !flagged.isEmpty {
        VStack(alignment: .leading, spacing: 9) {
          Text("FLAGGED FOR REVIEW").font(.system(size: 10, weight: .semibold)).tracking(2)
            .foregroundStyle(.orange)
          HStack(spacing: 8) {
            ForEach(flagged.sorted(), id: \.self) { id in
              Button {
                attentionOnly = true
              } label: {
                Text(id).font(.system(size: 10, weight: .semibold, design: .monospaced))
                  .padding(.horizontal, 9).padding(.vertical, 5)
                  .background(Color.orange.opacity(0.12), in: Capsule())
                  .foregroundStyle(Color.orange)
              }.buttonStyle(.plain).help("Show flagged scenes")
            }
          }
        }
      }
    }.padding(22).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 14)
  }

  private func caption(_ qa: QAReport) -> String {
    var parts: [String] = []
    if let build = p.latestBuild { parts.append("Rough cut v\(build.planVersion)") }
    if let at = checkedAt(qa.checkedAt) { parts.append("Checked \(at)") }
    if let by = qa.visual?.reviewedBy {
      parts.append("Vision review \(by)")
    } else {
      parts.append("Vision review not run")
    }
    return parts.joined(separator: " · ")
  }

  private func checkedAt(_ iso: String?) -> String? {
    guard let iso else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date =
      formatter.date(from: iso)
      ?? ISO8601DateFormatter().date(from: iso)
    return date?.formatted(date: .abbreviated, time: .shortened) ?? iso
  }

  private func fpsLabel(_ rate: Double?) -> String {
    guard let rate, rate > 0 else { return "—" }
    return rate.rounded() == rate ? String(Int(rate)) : String(format: "%.2f", rate)
  }

  private func flaggedSceneIds(_ qa: QAReport) -> Set<String> {
    var ids = Set(qa.attention ?? [])
    for verdict in qa.visual?.scenes ?? [] where verdict.verdict != "pass" {
      ids.insert(verdict.sceneId)
    }
    for still in qa.visual?.stills ?? [] where still.verdict != "pass" {
      ids.insert(still.sceneId)
    }
    return ids
  }

  // MARK: - Warnings

  private func warningsCard(_ qa: QAReport) -> some View {
    let items = qa.warnings ?? []
    return Group {
      if !items.isEmpty {
        VStack(alignment: .leading, spacing: 11) {
          QASectionLabel("Warnings", count: items.count)
          ForEach(items, id: \.self) { warning in
            HStack(alignment: .top, spacing: 8) {
              Image(systemName: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                .padding(.top, 1)
              Text(warning).font(.caption).lineSpacing(3).frame(
                maxWidth: .infinity, alignment: .leading)
            }
          }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
      }
    }
  }

  // MARK: - Scene verdicts

  private func sceneVerdicts(_ qa: QAReport) -> some View {
    let scenes = plan?.scenes ?? []
    let verdicts = Dictionary(
      (qa.visual?.scenes ?? []).map { ($0.sceneId, $0) },
      uniquingKeysWith: { first, _ in first })
    let flagged = flaggedSceneIds(qa)
    let visible = attentionOnly ? scenes.filter { flagged.contains($0.id) } : scenes
    return VStack(alignment: .leading, spacing: 12) {
      HStack {
        QASectionLabel("Scene verdicts", count: scenes.count)
        Spacer()
        Picker("Filter", selection: $attentionOnly) {
          Text("All").tag(false)
          Text("Needs attention (\(flagged.count))").tag(true)
        }.pickerStyle(.segmented).labelsHidden().controlSize(.small).frame(width: 250)
      }
      Text(
        "Each enabled scene is sampled at its midpoint from the assembled cut; the vision reviewer sees exactly this frame against the scene's intent."
      ).font(.caption2).foregroundStyle(.secondary)
      if visible.isEmpty {
        Text(
          attentionOnly
            ? "No scenes are flagged. Everything the reviewer sampled passed."
            : "No scenes to review yet."
        ).font(.caption).foregroundStyle(.secondary).padding(.vertical, 22).frame(
          maxWidth: .infinity, alignment: .center)
      }
      ForEach(visible) { scene in
        sceneCard(scene, verdict: verdicts[scene.id], flagged: flagged.contains(scene.id))
      }
    }
  }

  private func sceneCard(_ scene: ProductionScene, verdict: QASceneVerdict?, flagged: Bool)
    -> some View
  {
    HStack(alignment: .top, spacing: 14) {
      sceneThumb(scene)
        .frame(width: 132, height: 74)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
          RoundedRectangle(cornerRadius: 8).strokeBorder(Color.studioBorder, lineWidth: 0.7))
      VStack(alignment: .leading, spacing: 7) {
        HStack(spacing: 10) {
          Text(scene.id.uppercased()).font(
            .system(size: 10, weight: .semibold, design: .monospaced)
          )
          .foregroundStyle(.secondary)
          if let chapter = scene.chapterTitle {
            Label(chapter, systemImage: "bookmark.fill").font(.system(size: 10, weight: .medium))
              .foregroundStyle(Color.studioAccent).lineLimit(1)
          }
          Spacer()
          if flagged {
            VerdictChip(verdict: "ATTENTION")
          }
          VerdictChip(
            verdict: verdict?.verdict.uppercased() ?? (scene.enabled ? "NOT SAMPLED" : "DISABLED"))
        }
        Text(
          timestamp(Double(scene.startFrame) / fps) + "–"
            + timestamp(Double(scene.startFrame + scene.durationFrames) / fps)
        ).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
        if let verdict {
          if verdict.findings.isEmpty {
            Text("Passed without findings.").font(.caption).foregroundStyle(.secondary)
          } else {
            VStack(alignment: .leading, spacing: 6) {
              ForEach(Array(verdict.findings.enumerated()), id: \.offset) { _, finding in
                QAFindingRow(finding: finding)
              }
            }
          }
        } else if !scene.enabled {
          Text(
            "Visual disabled — the scene's A-roll and audio are included, but no frame was sampled."
          )
          .font(.caption).foregroundStyle(.secondary)
        } else {
          Text("No verdict recorded for this scene in the current report.").font(.caption)
            .foregroundStyle(.secondary)
        }
        Text(scene.narration).font(.caption).foregroundStyle(.secondary).lineLimit(2).lineSpacing(2)
      }
    }.padding(14).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
  }

  /// Prefer the frame the vision reviewer actually saw; fall back to sampling
  /// the same midpoint from the preview.
  @ViewBuilder private func sceneThumb(_ scene: ProductionScene) -> some View {
    if let url = sampledFrameURL(scene.id) {
      StillImage(url: url)
    } else if let preview = previewURL {
      MediaThumbnail(
        url: preview,
        seconds: (Double(scene.startFrame) + Double(scene.durationFrames) / 2) / fps)
    } else {
      ZStack {
        Color.studioAccent.opacity(0.08)
        Image(systemName: "photo").foregroundStyle(.secondary)
      }
    }
  }

  private func sampledFrameURL(_ sceneId: String) -> URL? {
    guard let dir = qa?.visual?.framesDir, let url = p.url("\(dir)/scene-\(sceneId)-0001.jpg"),
      FileManager.default.fileExists(atPath: url.path)
    else { return nil }
    return url
  }

  // MARK: - Generated stills

  private func stillsSection(_ qa: QAReport) -> some View {
    let stills = qa.visual?.stills ?? []
    let rank = { (verdict: String) -> Int in
      switch verdict {
      case "fail": return 0
      case "warn": return 1
      default: return 2
      }
    }
    return Group {
      if !stills.isEmpty {
        VStack(alignment: .leading, spacing: 12) {
          QASectionLabel("Generated stills", count: stills.count)
          Text(
            "Every generated still is reviewed before compositing; flagged images are never auto-regenerated — the decision stays with you."
          ).font(.caption2).foregroundStyle(.secondary)
          ForEach(stills.sorted { rank($0.verdict) < rank($1.verdict) }) { still in
            stillCard(still)
          }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
      }
    }
  }

  private func stillCard(_ still: QAStillVerdict) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Group {
        if let url = stillImageURL(still) {
          StillImage(url: url)
        } else {
          ZStack {
            Color.studioAccent.opacity(0.08)
            Image(systemName: "photo").foregroundStyle(.secondary)
          }
        }
      }.frame(width: 108, height: 60).clipShape(RoundedRectangle(cornerRadius: 7)).overlay(
        RoundedRectangle(cornerRadius: 7).strokeBorder(Color.studioBorder, lineWidth: 0.7))
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text("\(still.sceneId) · \(still.brollId)").font(
            .system(size: 10, weight: .semibold, design: .monospaced)
          ).foregroundStyle(.secondary)
          Spacer()
          VerdictChip(verdict: still.verdict.uppercased())
        }
        if let note = still.note, !note.isEmpty {
          Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        ForEach(Array(still.findings.enumerated()), id: \.offset) { _, finding in
          QAFindingRow(finding: finding)
        }
      }
    }.padding(11).background(
      Color.studioBackground, in: RoundedRectangle(cornerRadius: 9))
  }

  /// The still image itself is found through the job that generated it
  /// (jobs carry the `GeneratedStill • scene/broll` label), falling back to the
  /// scene's latest generated image.
  private func stillImageURL(_ still: QAStillVerdict) -> URL? {
    if let job = p.jobs?.first(where: {
      $0.label == "GeneratedStill • \(still.sceneId)/\(still.brollId)"
    }),
      let asset = p.assets?.first(where: { $0.jobId == job.id && $0.type == "generated-image" }),
      let url = p.url(asset.path), FileManager.default.fileExists(atPath: url.path)
    {
      return url
    }
    if let asset = p.assets?.last(where: {
      $0.type == "generated-image" && $0.sceneId == still.sceneId
    }),
      let url = p.url(asset.path)
    {
      return url
    }
    return nil
  }
}

/// Sidebar: automated checks, audio, anomalies, coverage, human checks, artifacts.
private struct Sidebar: View {
  @EnvironmentObject var m: StudioModel
  let qa: QAReport
  let p: Project

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      visionCard
      checksCard
      audioCard
      anomaliesCard
      coverageCard
      humanCard
      artifactsCard
    }.padding(24)
  }

  private var visionCard: some View {
    VStack(alignment: .leading, spacing: 9) {
      QASectionLabel("Vision review")
      if let by = qa.visual?.reviewedBy {
        Text(by).font(.system(size: 10, design: .monospaced)).foregroundStyle(Color.studioAccent)
          .textSelection(.enabled)
      }
      ForEach(qa.visual?.summaries ?? [], id: \.self) { summary in
        Text(summary).font(.caption).foregroundStyle(.secondary).lineSpacing(3)
      }
      if qa.visual?.framesDir == nil {
        Text(
          "Vision review did not run for this build — technical filters and human judgment still apply."
        ).font(.caption).foregroundStyle(.secondary).lineSpacing(3)
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
  }

  private var checksCard: some View {
    VStack(alignment: .leading, spacing: 9) {
      QASectionLabel("Automated checks")
      ForEach(qa.checks ?? [], id: \.self) { check in
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "checkmark.circle.fill").font(.caption2).foregroundStyle(
            Color.studioSuccess
          ).padding(.top, 2)
          Text(check).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
  }

  private var audioCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      QASectionLabel("Audio analysis")
      if let audio = qa.audio {
        HStack(alignment: .top, spacing: 14) {
          levelStat("Mean", audio.meanVolumeDb, warn: false)
          levelStat("Peak", audio.maxVolumeDb, warn: (audio.maxVolumeDb ?? -99) > -1)
        }
        let silences = audio.silenceStarts ?? []
        if silences.isEmpty {
          Label("No silence gaps of 2 seconds or more", systemImage: "waveform").font(.caption)
            .foregroundStyle(Color.studioSuccess)
        } else {
          DisclosureGroup(
            "\(silences.count) silence interval(s) ≥ \(Int(audio.minimumSilenceSeconds ?? 2)) s"
          ) {
            ForEach(Array(silences.enumerated()), id: \.offset) { _, start in
              Text(timestamp(start)).font(.system(size: 10, design: .monospaced)).foregroundStyle(
                .secondary
              ).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 2)
            }
          }.font(.caption)
        }
        if let note = audio.note {
          Text(note).font(.caption2).foregroundStyle(.secondary)
        }
      } else {
        Text("No audio diagnostics in this report.").font(.caption).foregroundStyle(.secondary)
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
  }

  private func levelStat(_ label: String, _ db: Double?, warn: Bool) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label.uppercased()).font(.system(size: 9, weight: .semibold)).tracking(1.5)
        .foregroundStyle(.secondary)
      Text(db.map { String(format: "%.1f dB", $0) } ?? "—").font(
        .system(size: 15, design: .monospaced)
      )
      .foregroundStyle(warn ? Color.orange : Color.studioInk)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private var anomaliesCard: some View {
    let black = qa.visual?.anomalies?.black ?? []
    let frozen = qa.visual?.anomalies?.frozen ?? []
    return VStack(alignment: .leading, spacing: 9) {
      QASectionLabel("Anomaly filters")
      if black.isEmpty && frozen.isEmpty {
        Label("No black or frozen intervals detected", systemImage: "checkmark.circle").font(
          .caption
        ).foregroundStyle(Color.studioSuccess)
      } else {
        ForEach(Array(black.enumerated()), id: \.offset) { _, interval in
          HStack(spacing: 8) {
            Image(systemName: "moon.fill").font(.caption2).foregroundStyle(.orange)
            Text("Black \(timestamp(interval.start))–\(timestamp(interval.end))").font(
              .system(size: 11, design: .monospaced)
            )
            Spacer()
          }
        }
        ForEach(Array(frozen.enumerated()), id: \.offset) { _, interval in
          HStack(spacing: 8) {
            Image(systemName: "snowflake").font(.caption2).foregroundStyle(.orange)
            Text("Frozen from \(timestamp(interval.start))").font(
              .system(size: 11, design: .monospaced))
            Spacer()
          }
        }
      }
      if let note = qa.visual?.anomalies?.note {
        Text(note).font(.caption2).foregroundStyle(.secondary)
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
  }

  private var coverageCard: some View {
    let coverage = qa.coverage ?? []
    return Group {
      if !coverage.isEmpty {
        VStack(alignment: .leading, spacing: 11) {
          QASectionLabel("Recording coverage")
          ForEach(coverage) { entry in
            VStack(alignment: .leading, spacing: 5) {
              HStack {
                Text(entry.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                Spacer()
                Text(
                  "\(seconds(entry.keptSeconds)) of \(seconds(entry.durationSeconds))"
                ).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
              }
              ProgressView(
                value: entry.durationSeconds > 0
                  ? min(1, entry.keptSeconds / entry.durationSeconds) : 0
              ).tint(entry.keptSeconds == 0 ? Color.orange : .studioAccent)
              if entry.keptSeconds == 0 {
                Text("Unused by this cut").font(.caption2).foregroundStyle(.orange)
              }
            }
          }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
      }
    }
  }

  private var humanCard: some View {
    VStack(alignment: .leading, spacing: 9) {
      QASectionLabel("Still yours to judge")
      ForEach(qa.humanChecks ?? [], id: \.self) { check in
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "circle.dashed").font(.caption2).foregroundStyle(.secondary).padding(
            .top, 2)
          Text(check).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      if let note = qa.coverageNote {
        Text(note).font(.caption2).foregroundStyle(.secondary).italic()
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
  }

  private var artifactsCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      QASectionLabel("Artifacts")
      if let build = p.latestBuild {
        Button("Reveal QA Report (JSON)") { m.reveal(p.url(build.qaPath)) }.buttonStyle(
          QuietButtonStyle())
        Button("Reveal Preview") { m.reveal(p.url(build.previewPath)) }.buttonStyle(
          QuietButtonStyle())
      }
      if let frames = qa.visual?.framesDir, let url = p.url(frames) {
        Button("Reveal Sampled Frames") { m.reveal(url) }.buttonStyle(QuietButtonStyle())
      }
      Button("Open Production") { m.tab = "Production" }.buttonStyle(QuietButtonStyle())
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 11)
  }

  private func seconds(_ value: Double) -> String {
    value >= 10 ? String(format: "%.0fs", value) : String(format: "%.1fs", value)
  }
}

// MARK: - Shared pieces

struct VerdictChip: View {
  let verdict: String
  private var tint: Color {
    switch verdict {
    case "PASS": return .studioSuccess
    case "WARN", "ATTENTION": return .orange
    case "FAIL": return .red
    default: return .secondary
    }
  }
  var body: some View {
    Text(verdict).font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1)
      .padding(.horizontal, 8).padding(.vertical, 4)
      .background(tint.opacity(0.12), in: Capsule()).foregroundStyle(tint)
  }
}

struct QAFindingRow: View {
  let finding: QAFinding
  private var icon: String {
    switch finding.severity {
    case "critical": return "xmark.circle.fill"
    case "warn": return "exclamationmark.triangle.fill"
    default: return "info.circle"
    }
  }
  private var tint: Color {
    switch finding.severity {
    case "critical": return .red
    case "warn": return .orange
    default: return .secondary
    }
  }
  var body: some View {
    HStack(alignment: .top, spacing: 7) {
      Image(systemName: icon).font(.caption2).foregroundStyle(tint).padding(.top, 2)
      VStack(alignment: .leading, spacing: 1) {
        Text(finding.kind.replacingOccurrences(of: "-", with: " ").capitalized).font(
          .system(size: 11, weight: .semibold)
        )
        Text(finding.evidence).font(.caption).foregroundStyle(.secondary).lineSpacing(2)
          .textSelection(.enabled)
      }
    }
  }
}

struct QASectionLabel: View {
  let title: String
  var count: Int?
  init(_ title: String, count: Int? = nil) {
    self.title = title
    self.count = count
  }
  var body: some View {
    HStack(spacing: 8) {
      Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(2)
        .foregroundStyle(.secondary)
      if let count {
        Text("\(count)").font(.system(size: 10, design: .monospaced)).foregroundStyle(
          Color.studioAccent)
      }
      Spacer()
    }
  }
}

/// A still image loaded straight from disk (sampled QA frames, generated stills).
struct StillImage: View {
  let url: URL
  @State private var image: NSImage?
  var body: some View {
    ZStack {
      Color.studioSurface
      if let image {
        Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
      } else {
        Image(systemName: "photo").foregroundStyle(.secondary)
      }
    }.clipped().task(id: url.absoluteString) {
      image = NSImage(contentsOf: url)
    }
  }
}
