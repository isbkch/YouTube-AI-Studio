import AppKit
import Charts
import SwiftUI
import UniformTypeIdentifiers

private enum ChannelSheet: String, Identifiable {
  case strategy, `import`, connect
  var id: String { rawValue }
}
private struct TopicEditor: Identifiable {
  let topic: ChannelTopic
  let creating: Bool
  var id: String { topic.id + (creating ? "-create" : "-edit") }
}

struct ChannelWorkspace: View {
  @ObservedObject var a: ChannelModel
  @State private var sheet: ChannelSheet?
  @State private var confirmDelete = false
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 7) {
          Text("Channel").studioHeading(30)
          Text("Business leads and authority").foregroundStyle(Color.studioAccent)
          Text(a.snapshot?.channel?.title ?? "Turn published work into your next useful topic.")
            .font(.callout).foregroundStyle(.secondary)
        }
        Spacer()
        if let s = a.snapshot, s.channels.count > 1 {
          Picker(
            "Channel",
            selection: Binding(
              get: { a.channelId ?? "" }, set: { id in Task { await a.switchChannel(id) } })
          ) {
            ForEach(s.channels) { c in Text(c.title).tag(c.id) }
          }.labelsHidden().frame(maxWidth: 220).disabled(a.busy)
        }
        Menu {
          Button("Channel strategy…") { sheet = .strategy }.disabled(a.snapshot?.channel == nil)
          Button("Import Studio CSV…") { sheet = .import }
          Button("Connect YouTube…") { sheet = .connect }
          Button("Explore sample channel") { Task { await a.sample() } }
          if a.snapshot?.channel?.connected == true {
            Button("Load 50 older videos") {
              Task {
                await a.perform(
                  "analytics.sync", label: "Loading older videos", params: ["older": true])
              }
            }
            Button("Enable reach reports") {
              Task { await a.perform("analytics.reach.enable", label: "Enabling reach reports") }
            }
            Button("Disconnect YouTube") {
              Task {
                await a.perform("analytics.connection.disconnect", label: "Disconnecting YouTube")
              }
            }
          }
          if a.snapshot?.channel != nil {
            Button("Delete local analytics…", role: .destructive) { confirmDelete = true }
          }
        } label: {
          Label("Manage", systemImage: "slider.horizontal.3")
        }.fixedSize().disabled(a.busy)
        if a.snapshot?.channel?.connected == true {
          Button {
            Task { await a.perform("analytics.sync", label: "Refreshing YouTube data") }
          } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
          }.disabled(a.busy)
        }
      }
      if a.busy {
        HStack {
          ProgressView().controlSize(.small)
          Text(a.progress)
          Spacer()
          Button("Cancel") { Task { await a.cancel() } }
        }.font(.callout)
      }
      if let error = a.error {
        Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(
          .enabled)
      }
      if let notice = a.notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
      if let s = a.snapshot, let channel = s.channel {
        ForEach(s.notices, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
        HStack {
          Picker("Workspace", selection: $a.tab) {
            ForEach(["Next Topics", "Video Evidence", "Outcomes"], id: \.self) { Text($0) }
          }.pickerStyle(.segmented).frame(maxWidth: 430)
          Spacer()
          Text(
            channel.lastSync.map { "Updated \(String($0.prefix(10))) · \(channel.status)" }
              ?? channel.status
          ).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        Divider()
        Group {
          switch a.tab {
          case "Video Evidence": ChannelVideosView(a: a, snapshot: s)
          case "Outcomes": ChannelOutcomesView(a: a, snapshot: s)
          default: ChannelTopicsView(a: a, snapshot: s, openStrategy: { sheet = .strategy })
          }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if a.snapshot != nil {
        VStack(spacing: 20) {
          Image(systemName: "chart.line.uptrend.xyaxis").font(.system(size: 42, weight: .light))
            .foregroundStyle(Color.studioAccent)
          Text("Give your next topic a reason.").studioHeading(27)
          Text(
            "Bring in YouTube Studio evidence, record real business outcomes, and decide what to make next."
          ).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 500)
          HStack {
            Button("Connect YouTube") { sheet = .connect }.buttonStyle(PrimaryActionButtonStyle())
            Button("Import Studio CSV") { sheet = .import }.buttonStyle(QuietButtonStyle())
          }
          Button("Explore with fictional sample data") { Task { await a.sample() } }.buttonStyle(
            .link)
          Text(
            "Read-only channel access. Business outcomes stay local unless you choose to share an anonymous summary."
          ).font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).task { await a.load() }
      }
    }.padding(28)
      .sheet(item: $sheet) { selected in
        switch selected {
        case .strategy:
          ChannelStrategySheet(a: a, strategy: a.snapshot?.strategy ?? ChannelStrategy())
        case .import: ChannelImportSheet(a: a)
        default: ChannelConnectionSheet(a: a)
        }
      }
      .confirmationDialog(
        "Delete local analytics?", isPresented: $confirmDelete, titleVisibility: .visible
      ) {
        Button("Delete analytics", role: .destructive) {
          Task {
            await a.perform(
              "analytics.data.delete", label: "Deleting analytics", params: ["confirm": true])
          }
        }
      } message: {
        Text(
          "Removes imported reports, YouTube evidence and local connection tokens. Your strategy, authored topic drafts, business records and productions remain. Revoke Google access separately in your Google Account."
        )
      }
  }
}

struct ChannelTopicsView: View {
  @ObservedObject var a: ChannelModel
  let snapshot: AnalyticsSnapshot
  let openStrategy: () -> Void

  @State private var editing: TopicEditor?
  @State private var dismissing: ChannelTopic?
  @State private var reason = ""
  private var topics: [ChannelTopic] {
    let matching = snapshot.topics.filter { $0.status == a.topicFilter }
    if a.topicFilter == "proposed" {
      return matching.filter { $0.batchId == snapshot.latestBatchId }
    }
    return Array(matching.reversed())
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 7) {
          Text("What deserves your next video?").studioHeading(24)
          Text(
            snapshot.strategy.buyer.isEmpty
              ? "Start with the buyer you want to help and the proof you can show."
              : "For \(snapshot.strategy.buyer)"
          ).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Strategy", action: openStrategy).buttonStyle(QuietButtonStyle())
        Button("Generate topics") {
          Task { await a.perform("topics.generate", label: "Generating topic briefs") }
        }.buttonStyle(PrimaryActionButtonStyle()).disabled(
          a.busy || snapshot.strategy.buyer.isEmpty)
      }
      Picker("Topic status", selection: $a.topicFilter) {
        Text("New").tag("proposed")
        Text("Saved").tag("saved")
        Text("In production").tag("in_production")
        Text("Dismissed").tag("dismissed")
      }.pickerStyle(.segmented).frame(maxWidth: 500)
      ScrollView {
        if topics.isEmpty {
          ContentUnavailableView(
            a.topicFilter == "proposed" ? "Your next topics start here" : "No topics here yet",
            systemImage: "lightbulb",
            description: Text(
              "Set your channel strategy, then generate a small set of editable briefs. Views are evidence of attention; they are not measured business leads."
            ))
        }
        LazyVStack(spacing: 16) {
          ForEach(topics) { t in
            VStack(alignment: .leading, spacing: 14) {
              HStack {
                Text(t.kind.replacingOccurrences(of: "-", with: " ").uppercased()).font(
                  .caption.weight(.semibold)
                ).tracking(1).foregroundStyle(Color.studioAccent)
                Spacer()
                Text(t.evidenceUnavailable ? "Evidence unavailable" : t.evidenceLabel.capitalized)
                  .font(.caption).padding(.horizontal, 9).padding(.vertical, 5).background(
                    Color.primary.opacity(0.05), in: Capsule())
                Text("\(t.targetDuration / 60) min · v\(t.version)").font(.caption).foregroundStyle(
                  .secondary)
              }
              Text(t.title).studioHeading(22)
              Text(t.thesis).font(.callout)
              HStack(alignment: .top, spacing: 30) {
                briefBlock("Buyer", t.buyer)
                briefBlock("Proof to show", t.proof)
                briefBlock("Next step", t.cta)
              }
              DisclosureGroup("Why this topic · evidence and uncertainty") {
                VStack(alignment: .leading, spacing: 10) {
                  briefBlock("Reason", t.rationale)
                  briefBlock("Counterevidence", t.counterEvidence)
                  briefBlock("Testable hypothesis", t.hypothesis)
                  if t.evidenceIds.isEmpty {
                    Text("Strategy-led exploration; no measured performance claim.")
                      .foregroundStyle(.secondary)
                  }
                  ForEach(t.evidenceIds, id: \.self) { id in
                    if let report = snapshot.reports.first(where: { $0.id == id }) {
                      Text(
                        "\(snapshot.videos.first(where: { $0.id == report.videoId })?.title ?? report.videoId) · \(report.start) – \(report.end) · \(report.coverage) · \(report.source)"
                      ).font(.caption)
                    } else if let review = snapshot.reviews.first(where: { $0.id == id }) {
                      Text("Creator lesson: \(review.lesson)").font(.caption)
                    } else if let outcome = snapshot.outcomes.first(where: { $0.id == id }) {
                      Text(
                        "Creator record: \(outcome.kind) · \(outcome.buyerFit) · \(outcome.attribution)"
                      ).font(.caption)
                    } else {
                      Text("Evidence no longer available").font(.caption).foregroundStyle(
                        .secondary)
                    }
                  }
                  if t.inputHash != snapshot.evidenceHash
                    || t.strategyVersion != snapshot.strategy.version
                  {
                    Text(
                      "Evidence has changed since this brief was generated. Review before selecting."
                    ).font(.caption).foregroundStyle(Color.studioAccent)
                  }
                  Text("Source: \(t.provider) · strategy v\(t.strategyVersion)").font(.caption)
                    .foregroundStyle(.secondary)
                }.padding(.top, 10).frame(maxWidth: .infinity, alignment: .leading)
              }
              if !t.reason.isEmpty {
                Text("Decision note: \(t.reason)").font(.caption).foregroundStyle(.secondary)
              }
              HStack {
                if t.status != "in_production" {
                  Button("Edit brief") {
                    editing = TopicEditor(topic: t, creating: false)
                  }
                  if t.status == "dismissed" {
                    Button("Restore") { decide(t, "proposed") }
                  } else {
                    Button(t.status == "saved" ? "Unsave" : "Save for later") {
                      decide(t, t.status == "saved" ? "proposed" : "saved")
                    }
                    Button("Dismiss…") {
                      reason = ""
                      dismissing = t
                    }
                    Spacer()
                    Button("Create project…") {
                      editing = TopicEditor(topic: t, creating: true)
                    }.buttonStyle(PrimaryActionButtonStyle()).disabled(
                      snapshot.channel?.mode == "sample")
                  }
                } else if let id = t.projectId {
                  ChannelProjectButton(id: id)
                }
              }.disabled(a.busy)
            }.padding(22).frame(maxWidth: .infinity, alignment: .leading).studioCard(
              cornerRadius: 14)
          }
        }
      }
    }.sheet(item: $editing) { editor in
      ChannelTopicSheet(a: a, topic: editor.topic, createProject: editor.creating)
    }
    .sheet(item: $dismissing) { topic in
      VStack(alignment: .leading, spacing: 18) {
        Text("Dismiss this topic").studioHeading(24)
        Text(topic.title)
        TextField("Optional reason for future suggestions", text: $reason, axis: .vertical)
          .lineLimit(3...5)
        HStack {
          Button("Cancel") { dismissing = nil }
          Spacer()
          Button("Dismiss") {
            decide(topic, "dismissed", reason)
            dismissing = nil
          }
        }
      }.padding(28).frame(width: 500)
    }
  }
  private func decide(_ t: ChannelTopic, _ status: String, _ reason: String = "") {
    Task {
      await a.perform(
        "topics.decide", label: "Updating topic",
        params: ["topicId": t.id, "status": status, "reason": reason])
    }
  }
}

private func briefBlock(_ label: String, _ value: String) -> some View {
  VStack(alignment: .leading, spacing: 5) {
    Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
    Text(value.isEmpty ? "Not specified" : value).font(.callout).textSelection(.enabled)
  }.frame(maxWidth: .infinity, alignment: .leading)
}
struct ChannelProjectButton: View {
  @EnvironmentObject var m: StudioModel
  let id: String
  var body: some View {
    Button("Open production") {
      Task {
        await m.select(id)
        m.tab = "Pre-Production"
      }
    }
  }
}
struct ChannelTopicSheet: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var a: ChannelModel
  @State var topic: ChannelTopic
  let createProject: Bool
  @State private var saving = false
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(createProject ? "Take this topic into production" : "Edit the topic brief")
        .studioHeading(25)
      Text(
        createProject
          ? "Creates an IDEA project with this hypothesis and source brief. Research starts when you choose it."
          : "Keep the buyer problem, demonstrable proof and next step concrete."
      ).foregroundStyle(.secondary)
      ScrollView {
        Form {
          TextField("Title", text: $topic.title)
          TextField("Target buyer", text: $topic.buyer, axis: .vertical)
          TextField("Thesis / buyer problem", text: $topic.thesis, axis: .vertical)
          TextField("Proof to demonstrate", text: $topic.proof, axis: .vertical)
          TextField("Call to action", text: $topic.cta, axis: .vertical)
          TextField("Why this topic", text: $topic.rationale, axis: .vertical)
          TextField("Counterevidence", text: $topic.counterEvidence, axis: .vertical)
          TextField("Testable hypothesis", text: $topic.hypothesis, axis: .vertical)
          Stepper(
            "Target: \(topic.targetDuration / 60) minutes", value: $topic.targetDuration,
            in: 60...10800, step: 60)
        }.formStyle(.grouped)
      }
      if let error { Text(error).foregroundStyle(.red) }
      HStack {
        Button("Cancel") { dismiss() }.disabled(saving)
        Spacer()
        Button(createProject ? "Create project" : "Save brief") { Task { await save() } }
          .buttonStyle(PrimaryActionButtonStyle()).disabled(saving || a.busy)
      }
    }.padding(26).frame(width: 650, height: 680)
  }
  private func save() async {
    saving = true
    defer { saving = false }
    do {
      let args: [String: Any] = [
        "channelId": topic.channelId, "topicId": topic.id, "version": topic.version,
        "brief": try topic.channelJSON(),
      ]
      if createProject {
        let project: Project = try await a.runtime.call("topics.createProject", args)
        await a.load()
        await m.select(project.id)
        m.tab = "Pre-Production"
        dismiss()
      } else {
        let _: AnyResponse = try await a.runtime.call("topics.update", args)
        await a.load()
        dismiss()
      }
    } catch { self.error = error.localizedDescription }
  }
}

struct ChannelStrategySheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var a: ChannelModel
  @State var strategy: ChannelStrategy
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Channel strategy").studioHeading(26)
      Text("Optimize for business leads and authority.").foregroundStyle(Color.studioAccent)
      Form {
        TextField("Target buyer", text: $strategy.buyer, axis: .vertical)
        TextField("Problem worth solving", text: $strategy.problem, axis: .vertical)
        TextField("Expertise / proof you can show", text: $strategy.expertise, axis: .vertical)
        TextField("Offer", text: $strategy.offer)
        TextField("Call to action", text: $strategy.cta)
        TextField(
          "Subjects (comma separated)",
          text: Binding(
            get: { strategy.subjects.joined(separator: ", ") },
            set: {
              strategy.subjects = $0.split(separator: ",").map {
                $0.trimmingCharacters(in: .whitespaces)
              }
            }))
        Section("Topic generation") {
          Toggle(
            "Allow evidence to be sent to the configured AI provider",
            isOn: $strategy.allowRemoteAnalysis)
          Toggle("Include anonymous outcome stages and attribution", isOn: $strategy.shareOutcomes)
          Text(
            "Personal notes and opportunity identifiers are never included in the outcome summary. The mock provider runs locally."
          ).font(.caption).foregroundStyle(.secondary)
          DisclosureGroup("Automated YouTube analysis") {
            Text(
              "YouTube API derived-metric approval is required before API data is used for automated topic insights. Leave this empty to use your strategy and creator lessons."
            ).font(.caption).foregroundStyle(.secondary)
            TextField("Recorded approval reference", text: $strategy.apiApprovalReference)
          }
        }
      }.formStyle(.grouped)
      if let error = a.error { Text(error).foregroundStyle(.red) }
      HStack {
        Button("Cancel") { dismiss() }
        Spacer()
        Button("Save strategy") {
          Task {
            if let json = try? strategy.channelJSON(),
              await a.perform(
                "channel.strategy.save", label: "Saving strategy", params: ["strategy": json])
            {
              dismiss()
            }
          }
        }.buttonStyle(PrimaryActionButtonStyle()).disabled(a.busy)
      }
    }.padding(26).frame(width: 640, height: 650)
  }
}

struct ChannelConnectionSheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var a: ChannelModel
  @State private var clientPath: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("Connect YouTube").studioHeading(26)
      Text(
        "Read your own channel and analytics. Sign-in opens in your default browser; refresh credentials are kept in macOS Keychain."
      ).foregroundStyle(.secondary)
      if let candidate = a.candidate {
        Text("Confirm the channel to use in this library").font(.headline)
        ForEach(candidate.channels) { channel in
          Button {
            Task {
              await a.confirm(channel)
              if a.candidate == nil {
                dismiss()
                await a.perform("analytics.sync", label: "Refreshing YouTube data")
              }
            }
          } label: {
            VStack(alignment: .leading) {
              Text(channel.title).font(.headline)
              Text(channel.id).font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
          }.disabled(a.busy)
        }
      } else {
        Text(
          "Use a Google Desktop OAuth client from a separate Cloud project with YouTube Data, Analytics and Reporting APIs enabled. Separate credentials keep this connection independent of the publishing uploader."
        ).font(.callout)
        HStack {
          Button("Choose Desktop client JSON…") {
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.json]
            if panel.runModal() == .OK { clientPath = panel.url?.path }
          }
          Text(
            clientPath.map { URL(fileURLWithPath: $0).lastPathComponent }
              ?? "Saved client will be used if configured"
          ).font(.caption).foregroundStyle(.secondary)
        }
        Button("Continue with Google") { Task { await a.connect(clientPath: clientPath) } }
          .buttonStyle(PrimaryActionButtonStyle()).disabled(a.busy)
      }
      if a.busy {
        HStack {
          ProgressView().controlSize(.small)
          Text(a.progress)
        }
      }
      if let error = a.error { Text(error).foregroundStyle(.red) }
      Button("Cancel") {
        Task {
          await a.cancel()
          dismiss()
        }
      }
    }.padding(28).frame(width: 570).interactiveDismissDisabled(a.busy || a.candidate != nil)
  }
}

struct ChannelImportSheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var a: ChannelModel
  @State private var path = ""
  @State private var channelID = ""
  @State private var title = ""
  @State private var start = ""
  @State private var end = ""
  @State private var filters = "All content"
  @State private var mapping: [String: String] = [:]
  @State private var preview: ChannelImportPreview?
  @State private var confirmed = false
  @State private var complete = false
  @State private var working = false
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Import YouTube Studio evidence").studioHeading(25)
      Text(
        "Export a video table from Studio Advanced mode. Confirm the report's channel, dates and filters; a CSV does not prove channel ownership."
      ).foregroundStyle(.secondary)
      ScrollView {
        Form {
          HStack {
            Button("Choose CSV…") {
              let panel = NSOpenPanel()
              panel.allowedContentTypes = [.commaSeparatedText, .plainText]
              if panel.runModal() == .OK {
                path = panel.url?.path ?? ""
                reset()
              }
            }
            Text(path.isEmpty ? "No file selected" : URL(fileURLWithPath: path).lastPathComponent)
              .font(.caption)
          }
          TextField("YouTube channel ID", text: $channelID)
          TextField("Channel name", text: $title)
          TextField("First report date (YYYY-MM-DD)", text: $start)
          TextField("Last report date (YYYY-MM-DD)", text: $end)
          TextField("Studio report filters", text: $filters)
          Text(
            "Dates use YouTube's Pacific time zone. Missing metrics remain unavailable; overlapping reports are stored separately and never added together."
          ).font(.caption).foregroundStyle(.secondary)
          DisclosureGroup("Map localized or custom headers") {
            Text("Enter the exact CSV header for any field that is not recognized automatically.")
              .font(.caption)
            ForEach(
              [
                "videoId", "title", "views", "watchMinutes", "averageViewDuration",
                "averageViewPercentage", "subscribersGained", "subscribersLost", "impressions",
                "ctr",
              ], id: \.self
            ) { field in
              TextField(
                field,
                text: Binding(
                  get: { mapping[field] ?? "" },
                  set: {
                    mapping[field] = $0
                    reset()
                  }))
            }
          }
        }.formStyle(.grouped)
        if let preview {
          VStack(alignment: .leading, spacing: 10) {
            Text("\(preview.rowCount) videos · \(preview.totalsSkipped) total rows excluded").font(
              .headline)
            Text(preview.videoTitles.joined(separator: "\n")).font(.caption)
            if preview.duplicate {
              Text("This report is already imported. Importing again refreshes the same records.")
                .foregroundStyle(Color.studioAccent)
            }
            if preview.overlapping > 0 {
              Text("\(preview.overlapping) rows overlap existing report intervals.").font(.caption)
            }
            ForEach(preview.warnings, id: \.self) {
              Text($0).font(.caption).foregroundStyle(.secondary)
            }
            Toggle(
              "I checked this channel, date interval and filters against Studio", isOn: $confirmed)
            Toggle("Studio shows complete data through the last report date", isOn: $complete)
          }.padding(16).studioCard(cornerRadius: 12)
        }
      }
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      HStack {
        Button("Cancel") { dismiss() }.disabled(working)
        Spacer()
        Button("Preview import") { Task { await makePreview() } }.disabled(path.isEmpty || working)
        Button("Import report") { Task { await commit() } }.buttonStyle(PrimaryActionButtonStyle())
          .disabled(preview == nil || !confirmed || working)
      }
    }.padding(26).frame(width: 650, height: 700)
      .onAppear {
        if let c = a.snapshot?.channel, c.mode != "sample" {
          channelID = c.id
          title = c.title
        }
      }
      .onChange(of: channelID) { reset() }.onChange(of: title) { reset() }.onChange(of: start) {
        reset()
      }.onChange(of: end) { reset() }.onChange(of: filters) { reset() }
      .interactiveDismissDisabled(working)
  }
  private func reset() {
    preview = nil
    confirmed = false
    complete = false
  }
  private func makePreview() async {
    working = true
    error = nil
    defer { working = false }
    do {
      preview = try await a.runtime.call(
        "analytics.import.preview",
        [
          "path": path,
          "options": [
            "channelId": channelID, "channelTitle": title, "start": start, "end": end,
            "filters": filters, "mapping": mapping.filter { !$0.value.isEmpty },
          ],
        ])
    } catch { self.error = error.localizedDescription }
  }
  private func commit() async {
    guard let preview else { return }
    working = true
    defer { working = false }
    do {
      let result: AnalyticsSnapshot = try await a.runtime.call(
        "analytics.import.commit",
        ["token": preview.token, "confirm": confirmed, "coverageConfirmed": complete])
      a.snapshot = result
      a.channelId = result.channel?.id
      a.tab = "Video Evidence"
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

struct ChannelVideosView: View {
  @ObservedObject var a: ChannelModel
  let snapshot: AnalyticsSnapshot
  @State private var selected: String?
  @State private var editing: ChannelVideo?
  @State private var days = 28
  @State private var search = ""
  private var videos: [ChannelVideo] {
    snapshot.videos.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Published work, with context").studioHeading(24)
        Spacer()
        TextField("Find a video", text: $search).textFieldStyle(.roundedBorder).frame(width: 210)
        Picker("Window", selection: $days) {
          Text("First 7 days").tag(7)
          Text("First 28 days").tag(28)
          Text("First 90 days").tag(90)
        }.frame(width: 160)
      }
      Text(
        "Compare public, long-form videos over the same completed window. Confirm the format and public date for imported videos."
      ).font(.callout).foregroundStyle(.secondary)
      HSplitView {
        Table(videos, selection: $selected) {
          TableColumn("Video") { v in
            VStack(alignment: .leading, spacing: 5) {
              Text(v.title).font(.headline).lineLimit(2)
              Text("\(v.format) · \(v.visibility)\(v.excluded ? " · excluded" : "")").font(.caption)
                .foregroundStyle(.secondary)
              Text(v.publicDate ?? "Public date unverified").font(.caption).foregroundStyle(
                .secondary)
            }.padding(.vertical, 6)
          }.width(min: 180, ideal: 230)
          TableColumn("Views") { v in
            Text(windowMetric(v, "views")).font(.callout.monospacedDigit())
          }.width(65)
          TableColumn("Viewed") { v in
            Text(windowMetric(v, "averageViewPercentage")).font(.callout.monospacedDigit())
          }.width(70)
        }.frame(minWidth: 340, idealWidth: 400)
        ScrollView {
          if let v = snapshot.videos.first(where: { $0.id == selected }) {
            VStack(alignment: .leading, spacing: 18) {
              Text(v.title).studioHeading(22)
              HStack {
                Button("Edit context…") { editing = v }
                if let id = v.projectId { ChannelProjectButton(id: id) }
                if snapshot.channel?.mode != "sample",
                  let url = URL(
                    string:
                      "https://studio.youtube.com/video/\(v.id)/analytics/tab-overview/period-default"
                  )
                {
                  Link("YouTube Studio", destination: url)
                }
              }
              Text("Public date: \(v.publicDate ?? "unverified") · source: \(v.publicDateSource)")
                .font(.caption).foregroundStyle(.secondary)
              let end = expectedEnd(v.publicDate)
              let exact = snapshot.reports.filter {
                $0.videoId == v.id && $0.family == "basic" && $0.start == v.publicDate
                  && $0.end == end
              }
              if exact.isEmpty {
                Text(
                  "No exact first-\(days)-day report. Other imported intervals below remain separate."
                ).foregroundStyle(.secondary)
              }
              ForEach(exact) { report in ChannelReportCard(report: report) }
              let other = snapshot.reports.filter {
                $0.videoId == v.id && !exact.map(\.id).contains($0.id)
              }
              // Each interval is an independent source, never a summed total.
              DisclosureGroup("All available reports") {
                ForEach(
                  snapshot.reports.filter { $0.videoId == v.id && !exact.map(\.id).contains($0.id) }
                ) { report in ChannelReportCard(report: report) }
              }
              if other.isEmpty && snapshot.reports.filter({ $0.videoId == v.id }).isEmpty {
                Text("No reports imported yet.").foregroundStyle(.secondary)
              }
              if snapshot.channel?.connected == true {
                HStack {
                  ForEach(["traffic", "search", "retention"], id: \.self) { family in
                    Button("Load \(family)") {
                      Task {
                        await a.perform(
                          "analytics.video.details", label: "Loading \(family)",
                          params: ["videoId": v.id, "family": family])
                      }
                    }
                  }
                }.disabled(a.busy)
              }
            }.padding(18)
          } else {
            ContentUnavailableView(
              "Select a video", systemImage: "play.rectangle",
              description: Text("Inspect dated source reports and confirm editorial context."))
          }
        }.frame(minWidth: 340)
      }
    }.sheet(item: $editing) { video in ChannelVideoSheet(a: a, video: video) }
      .onAppear { if selected == nil { selected = videos.first?.id } }
  }
  private func windowMetric(_ video: ChannelVideo, _ name: String) -> String {
    let reports = snapshot.reports.filter {
      $0.videoId == video.id && $0.family == "basic" && $0.coverage == "complete"
        && $0.start == video.publicDate && $0.end == expectedEnd(video.publicDate)
    }
    let report =
      reports.first { $0.source == "youtube" }
      ?? reports.sorted { $0.fetchedAt > $1.fetchedAt }.first
    guard video.format == "long-form", video.visibility == "public", !video.excluded else {
      return "Excluded"
    }
    return report?.metrics.first { $0.name == name }?.display ?? "—"
  }
  private func expectedEnd(_ start: String?) -> String? {
    guard let start else { return nil }
    let format = DateFormatter()
    format.dateFormat = "yyyy-MM-dd"
    format.timeZone = TimeZone(secondsFromGMT: 0)
    guard let date = format.date(from: start) else { return nil }
    return format.string(from: date.addingTimeInterval(Double(days - 1) * 86400))
  }
}
struct ChannelReportCard: View {
  let report: ChannelReport
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(report.family.capitalized).font(.headline)
        Spacer()
        Text(report.coverage.capitalized).font(.caption).foregroundStyle(
          report.coverage == "complete" ? Color.studioSuccess : Color.secondary)
      }
      Text("\(report.start) – \(report.end) · \(report.timezone)").font(.caption)
      Text(
        "\(report.source) · through \(report.through ?? "unknown") · fetched \(String(report.fetchedAt.prefix(10)))"
      ).font(.caption).foregroundStyle(.secondary)
      Text("Filters: \(report.filters)").font(.caption).foregroundStyle(.secondary)
      LazyVGrid(
        columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 14
      ) {
        ForEach(report.metrics) { metric in
          VStack(alignment: .leading, spacing: 4) {
            Text(metric.display).font(.title3)
            Text(metric.label).font(.caption).foregroundStyle(.secondary)
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      if report.family == "retention", !report.details.isEmpty {
        Chart(Array(report.details.enumerated()), id: \.offset) { _, detail in
          if let position = Double(detail.label) {
            LineMark(
              x: .value("Video elapsed (%)", position * 100), y: .value("Watch ratio", detail.value)
            ).foregroundStyle(Color.studioAccent)
          }
        }.frame(height: 160).chartXAxisLabel("Video elapsed (%)").chartYAxisLabel("Watch ratio")
        Text("Watch ratio can exceed 1 with rewatches; this is not a unique-viewer survival curve.")
          .font(.caption).foregroundStyle(.secondary)
      }
      ForEach(Array(report.details.enumerated()), id: \.offset) { _, detail in
        HStack {
          Text(detail.label)
          Spacer()
          Text(detail.value.formatted())
        }.font(.caption)
      }
    }.padding(16).studioCard(cornerRadius: 12)
  }
}
struct ChannelVideoSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject var m: StudioModel
  @ObservedObject var a: ChannelModel
  @State var video: ChannelVideo
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Video context").studioHeading(25)
      Text(video.title).font(.headline)
      Form {
        Picker("Format", selection: $video.format) {
          ForEach(["unknown", "long-form", "short", "live"], id: \.self) { Text($0) }
        }
        Picker("Visibility", selection: $video.visibility) {
          ForEach(["unknown", "public", "private", "unlisted"], id: \.self) { Text($0) }
        }
        TextField(
          "Verified public date (YYYY-MM-DD)",
          text: Binding(
            get: { video.publicDate ?? "" }, set: { video.publicDate = $0.isEmpty ? nil : $0 }))
        TextField(
          "Topic tags (comma separated)",
          text: Binding(
            get: { video.tags.joined(separator: ", ") },
            set: {
              video.tags = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            }))
        Toggle("Exclude from topic evidence and review queue", isOn: $video.excluded)
        Picker(
          "Linked production",
          selection: Binding(
            get: { video.projectId ?? "" }, set: { video.projectId = $0.isEmpty ? nil : $0 })
        ) {
          Text("No linked production").tag("")
          ForEach(m.projects) { p in Text(p.title).tag(p.id) }
        }
        Text(
          "An upload timestamp is not a public release date. Imported metadata is creator-confirmed; a YouTube refresh can update visibility."
        ).font(.caption).foregroundStyle(.secondary)
      }.formStyle(.grouped)
      if let error = a.error { Text(error).foregroundStyle(.red) }
      HStack {
        Button("Cancel") { dismiss() }
        Spacer()
        Button("Save context") {
          Task {
            if let json = try? video.channelJSON(),
              await a.perform(
                "analytics.video.save", label: "Saving video context", params: ["video": json])
            {
              dismiss()
            }
          }
        }.disabled(a.busy).buttonStyle(PrimaryActionButtonStyle())
      }
    }.padding(26).frame(width: 620, height: 510)
  }
}

struct ChannelOutcomesView: View {
  @ObservedObject var a: ChannelModel
  let snapshot: AnalyticsSnapshot
  @State private var outcome: ChannelOutcome?
  @State private var review: ReviewQueueItem?
  @State private var state = "due"
  private var uniqueOpportunities: Int {
    Set(
      snapshot.outcomes.filter { $0.buyerFit == "qualified" && $0.kind != "authority" }.map(
        \.opportunityId)
    ).count
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        HStack {
          VStack(alignment: .leading, spacing: 6) {
            Text("What did this work make possible?").studioHeading(24)
            Text("Creator-recorded outcomes, separate from YouTube attention metrics.")
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button("Record outcome…") {
            outcome = ChannelOutcome(
              id: "outcome-" + UUID().uuidString, channelId: a.channelId ?? "",
              opportunityId: "opp-" + String(UUID().uuidString.prefix(8)), videoId: nil,
              topicId: nil,
              date: String(ISO8601DateFormatter().string(from: Date()).prefix(10)),
              kind: "conversation", buyerFit: "uncertain", attribution: "channel-uncertain",
              note: "")
          }.buttonStyle(PrimaryActionButtonStyle()).disabled(a.busy)
        }
        HStack(spacing: 16) {
          briefBlock(
            "Qualified opportunities / conversations",
            snapshot.outcomes.isEmpty
              ? "Not recorded" : "\(uniqueOpportunities) unique anonymous IDs")
          briefBlock(
            "Authority signals",
            "\(snapshot.outcomes.filter { $0.kind == "authority" }.count) creator records")
          briefBlock(
            "Ready for review",
            "\(snapshot.queue.filter { $0.state == "due" }.count) completed windows")
        }.padding(20).studioCard(cornerRadius: 14)
        VStack(alignment: .leading, spacing: 14) {
          HStack {
            Text("7 / 28 / 90-day review queue").font(.headline)
            Spacer()
            Picker("Show", selection: $state) {
              ForEach(["due", "waiting", "snoozed", "reviewed"], id: \.self) {
                Text($0.capitalized)
              }
            }.frame(width: 150)
          }
          Text(
            "A review becomes due only after the public window has complete source coverage. Missing business records are unknown until you review them."
          ).font(.caption).foregroundStyle(.secondary)
          ForEach(snapshot.queue.filter { $0.state == state }) { item in
            HStack {
              VStack(alignment: .leading, spacing: 5) {
                Text(item.title).font(.headline)
                Text("First \(item.days) days · through \(item.end) · \(item.state)").font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              if item.state == "reviewed" {
                Button("Draft follow-up") {
                  Task {
                    await a.perform(
                      "reviews.followUp", label: "Saving follow-up draft",
                      params: ["reviewId": item.id])
                    a.topicFilter = "saved"
                    a.tab = "Next Topics"
                  }
                }
              }
              if snapshot.videos.contains(where: { $0.id == item.videoId }) {
                Button(item.state == "waiting" ? "Inspect / snooze" : "Review") { review = item }
              }
            }.padding(14).studioCard(cornerRadius: 10)
          }
          if snapshot.queue.filter({ $0.state == state }).isEmpty {
            Text(
              "No \(state) reviews. Public long-form videos with a verified release date appear here."
            ).font(.callout).foregroundStyle(.secondary).padding(.vertical, 10)
          }
        }
        VStack(alignment: .leading, spacing: 12) {
          Text("Business outcome ledger").font(.headline)
          Text(
            "Use the same anonymous opportunity ID as a conversation progresses. Attribution is your observation, not proof that a video caused a sale."
          ).font(.caption).foregroundStyle(.secondary)
          ForEach(snapshot.outcomes.reversed()) { record in
            Button {
              outcome = record
            } label: {
              HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                  Text("\(record.kind.capitalized) · \(record.buyerFit)").font(.headline)
                  Text(
                    record.videoId.flatMap { id in snapshot.videos.first { $0.id == id }?.title }
                      ?? "Channel-level / source unavailable"
                  ).font(.callout)
                  Text("\(record.opportunityId) · \(record.attribution)").font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Text(record.date).font(.caption)
              }.padding(16).frame(maxWidth: .infinity, alignment: .leading).studioCard(
                cornerRadius: 12)
            }.buttonStyle(.plain)
          }
          if snapshot.outcomes.isEmpty {
            Text(
              "No outcomes recorded yet. Start with a qualified conversation, customer opportunity or authority signal."
            ).foregroundStyle(.secondary)
          }
        }
      }
    }.sheet(item: $outcome) { record in
      ChannelOutcomeSheet(a: a, snapshot: snapshot, outcome: record)
    }
    .sheet(item: $review) { item in ChannelReviewSheet(a: a, snapshot: snapshot, item: item) }
  }
}
struct ChannelOutcomeSheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var a: ChannelModel
  let snapshot: AnalyticsSnapshot
  @State var outcome: ChannelOutcome
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Record a business outcome").studioHeading(25)
      Text(
        "Use anonymous IDs and factual observations. Keep names, email addresses and deal details out of notes."
      ).foregroundStyle(.secondary)
      Form {
        TextField("Anonymous opportunity ID", text: $outcome.opportunityId)
        TextField("Date (YYYY-MM-DD)", text: $outcome.date)
        Picker("Stage / signal", selection: $outcome.kind) {
          ForEach(["conversation", "opportunity", "customer", "authority"], id: \.self) {
            Text($0.capitalized)
          }
        }
        Picker("Buyer fit", selection: $outcome.buyerFit) {
          ForEach(["qualified", "uncertain", "not-fit"], id: \.self) { Text($0) }
        }
        Picker("Attribution", selection: $outcome.attribution) {
          Text("Prospect named this video").tag("prospect-named-video")
          Text("Creator-associated").tag("creator-associated")
          Text("Channel-level / uncertain").tag("channel-uncertain")
        }
        Picker(
          "Video",
          selection: Binding(
            get: { outcome.videoId ?? "" }, set: { outcome.videoId = $0.isEmpty ? nil : $0 })
        ) {
          Text("No specific video").tag("")
          ForEach(snapshot.videos) { Text($0.title).tag($0.id) }
          if let missing = outcome.videoId, !snapshot.videos.contains(where: { $0.id == missing }) {
            Text("Source video unavailable").tag(missing)
          }
        }
        Picker(
          "Topic brief",
          selection: Binding(
            get: { outcome.topicId ?? "" }, set: { outcome.topicId = $0.isEmpty ? nil : $0 })
        ) {
          Text("No specific brief").tag("")
          ForEach(snapshot.topics) { Text($0.title).tag($0.id) }
        }
        TextField("Local note", text: $outcome.note, axis: .vertical).lineLimit(3...5)
      }.formStyle(.grouped)
      if let error = a.error { Text(error).foregroundStyle(.red) }
      HStack {
        Button("Cancel") { dismiss() }
        Spacer()
        Button("Save outcome") {
          Task {
            if let json = try? outcome.channelJSON(),
              await a.perform("outcomes.save", label: "Saving outcome", params: ["outcome": json])
            {
              dismiss()
            }
          }
        }.buttonStyle(PrimaryActionButtonStyle()).disabled(a.busy)
      }
    }.padding(26).frame(width: 650, height: 590)
  }
}
struct ChannelReviewSheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var a: ChannelModel
  let snapshot: AnalyticsSnapshot
  let item: ReviewQueueItem
  @State private var decision = "inconclusive"
  @State private var lesson = ""
  @State private var checked = false
  @State private var noOutcomes = false
  @State private var snooze = false
  @State private var snoozeDate = ""
  @State private var followUp = false
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("First \(item.days) days: editorial review").studioHeading(25)
      Text(item.title).font(.headline)
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          briefBlock("Original hypothesis", item.hypothesis)
          ForEach(
            snapshot.reports.filter {
              $0.videoId == item.videoId && $0.family == "basic" && $0.end == item.end
                && $0.start == snapshot.videos.first(where: { $0.id == item.videoId })?.publicDate
            }
          ) { ChannelReportCard(report: $0) }
          Text(
            "Business records linked to this video: \(snapshot.outcomes.filter { $0.videoId == item.videoId }.count). Attribution remains creator-reported."
          ).font(.caption).foregroundStyle(.secondary)
          Form {
            Picker("Editorial decision", selection: $decision) {
              ForEach(
                ["follow-up", "change-angle", "explore-adjacent", "inconclusive"], id: \.self
              ) { Text($0) }
            }
            TextField("Lesson / uncertainty", text: $lesson, axis: .vertical).lineLimit(3...6)
            Toggle("I reviewed the business outcomes for this window", isOn: $checked)
            Toggle("No business outcomes observed in this window", isOn: $noOutcomes).disabled(
              !checked)
            Toggle("Snooze this review", isOn: $snooze)
            if snooze {
              TextField("Snooze until (YYYY-MM-DD)", text: $snoozeDate)
            } else {
              Toggle("Save a follow-up topic draft", isOn: $followUp)
            }
          }.formStyle(.grouped)
        }
      }
      if let error = a.error { Text(error).foregroundStyle(.red) }
      HStack {
        Button("Cancel") { dismiss() }
        Spacer()
        Button(snooze ? "Snooze" : "Save review") { Task { await save() } }.buttonStyle(
          PrimaryActionButtonStyle()
        ).disabled(a.busy || (!snooze && item.state == "waiting"))
      }
    }.padding(26).frame(width: 660, height: 690)
      .onAppear {
        if let review = item.review {
          decision = review.decision
          lesson = review.lesson
          checked = review.outcomesReviewed
          noOutcomes = review.noOutcomes
        }
        snooze = item.state == "waiting"
        snoozeDate = String(
          ISO8601DateFormatter().string(from: Date().addingTimeInterval(7 * 86400)).prefix(10))
      }
  }
  private func save() async {
    let review = ChannelReview(
      id: item.id, channelId: a.channelId ?? "", videoId: item.videoId, days: item.days,
      decision: decision, lesson: lesson, outcomesReviewed: checked,
      noOutcomes: checked && noOutcomes, reviewedAt: ISO8601DateFormatter().string(from: Date()),
      snoozedUntil: snooze ? snoozeDate : nil)
    if let json = try? review.channelJSON(),
      await a.perform("reviews.save", label: "Saving review", params: ["review": json])
    {
      if followUp && !snooze {
        await a.perform(
          "reviews.followUp", label: "Saving follow-up draft", params: ["reviewId": item.id])
        a.topicFilter = "saved"
        a.tab = "Next Topics"
      }
      dismiss()
    }
  }
}
