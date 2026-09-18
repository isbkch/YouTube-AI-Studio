import AppKit
import ImageIO
import SwiftUI

struct ThumbnailSection: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  @State private var comparing = false
  @State private var settings = false
  private var document: ThumbnailDocument? {
    guard let d = m.thumbnails, d.projectId == p.id,
      d.state.current.packagingVersion == p.packaging?.version
    else { return nil }
    return d
  }
  var body: some View {
    if let d = document {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("Thumbnails").font(.headline)
          Spacer()
          Text(
            d.provider == "mock"
              ? "Mock previews" : (d.provider?.capitalized ?? "Images unavailable")
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        HStack(alignment: .top, spacing: 12) {
          ForEach(d.state.current.slots) { slot in
            VStack(alignment: .leading, spacing: 6) {
              Button {
                comparing = true
              } label: {
                ThumbnailImage(p: p, revision: slot.current, headline: slot.headline)
              }.buttonStyle(.plain).help("Compare and edit thumbnail \(slot.id)")
              Text("\(slot.id) · \(slot.current?.headline ?? slot.headline)")
                .font(.caption).lineLimit(2)
              ThumbnailStatus(slot: slot)
            }.frame(maxWidth: .infinity, alignment: .topLeading)
          }
        }
        if let choice = d.state.selected {
          Label(
            "Upload: \(choice.slot) · revision \(choice.revision)",
            systemImage: "photo.badge.checkmark"
          )
          .font(.caption).foregroundStyle(Color.studioSuccess)
        } else {
          Text("No custom thumbnail selected.").font(.caption).foregroundStyle(.secondary)
        }
        HStack {
          if p.publication == nil {
            let pending = d.state.current.slots.filter { $0.status != "READY" }
            let newImages = pending.filter { $0.background == nil }.count
            Button(
              d.provider == "mock" ? "Render A/B (mock)" : "Render A/B · \(newImages) new images"
            ) {
              Task { await m.renderThumbnails(pending) }
            }.buttonStyle(QuietButtonStyle())
              .disabled(
                m.busy || pending.isEmpty || (d.provider == nil && newImages > 0)
                  || p.status != "AWAITING_PUBLISH_APPROVAL")
          }
          Button("Compare & edit…") { comparing = true }.buttonStyle(QuietButtonStyle())
          Spacer(minLength: 0)
        }
        HStack {
          Button("Export A/B…") { Task { await m.exportThumbnails() } }
            .buttonStyle(QuietButtonStyle())
            .disabled(m.busy || !d.state.current.slots.allSatisfy { $0.status == "READY" })
          if d.provider == nil && p.publication == nil {
            Button("Image Settings…") { settings = true }.buttonStyle(QuietButtonStyle())
          }
        }
        ThumbnailRecovery(document: d)
        if d.provider == "mock" {
          Text(
            "Mock mode renders gradient backgrounds. Choose an image provider in Settings for generated artwork."
          )
          .font(.caption2).foregroundStyle(.secondary)
        }
      }
      .sheet(isPresented: $comparing) {
        ThumbnailComparisonView(projectID: p.id).environmentObject(m)
      }
      .sheet(isPresented: $settings) {
        SettingsView().environmentObject(m).frame(width: 760, height: 780)
      }
    }
  }
}

struct ThumbnailRecovery: View {
  @EnvironmentObject var m: StudioModel
  let document: ThumbnailDocument
  var body: some View {
    if !m.busy && document.state.current.slots.contains(where: { $0.status == "RUNNING" }) {
      Button("Recover interrupted render") {
        Task {
          await m.perform(
            "project.recover", label: "Recover thumbnail rendering",
            params: ["projectId": document.projectId])
        }
      }.buttonStyle(QuietButtonStyle())
        .help(
          "Mark interrupted work failed so it can be retried. An active operation keeps its lock.")
    }
  }
}

struct ThumbnailImage: View {
  let p: Project
  let revision: ThumbnailRevision?
  let headline: String
  @State private var loadedImage: NSImage?
  @State private var loadedKey: String?
  private var imageKey: String { "\(p.id):\(revision?.path ?? ""):\(revision?.outputHash ?? "")" }
  var body: some View {
    Group {
      if let revision, loadedKey == imageKey, let image = loadedImage {
        Image(nsImage: image).resizable().aspectRatio(16 / 9, contentMode: .fit)
          .accessibilityLabel("Thumbnail: \(revision.headline)")
      } else {
        ZStack {
          Color.studioInk.opacity(0.06)
          VStack(spacing: 8) {
            Image(systemName: "photo").font(.title2)
            Text(revision == nil ? headline : "Image unavailable").font(.caption)
              .multilineTextAlignment(.center).lineLimit(3)
          }.foregroundStyle(.secondary).padding(16)
        }.aspectRatio(16 / 9, contentMode: .fit)
      }
    }.clipShape(RoundedRectangle(cornerRadius: 7))
      .task(id: imageKey) {
        loadedImage = nil
        loadedKey = nil
        guard let revision, let url = p.url(revision.path) else { return }
        let decoded = await Task.detached(priority: .userInitiated) { () -> CGImage? in
          guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
          return CGImageSourceCreateImageAtIndex(
            source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        }.value
        guard !Task.isCancelled else { return }
        loadedKey = imageKey
        if let decoded { loadedImage = NSImage(cgImage: decoded, size: .zero) }
      }
  }
}

struct ThumbnailStatus: View {
  let slot: ThumbnailSlot
  var body: some View {
    if slot.status == "RUNNING" {
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text(slot.stage ?? "Rendering")
      }
      .font(.caption2).foregroundStyle(.secondary)
    } else if let error = slot.error {
      Label(error, systemImage: "exclamationmark.triangle").font(.caption2).foregroundStyle(.orange)
        .lineLimit(3).help(error)
    } else {
      Text(
        slot.status == "READY" ? "Ready · revision \(slot.currentRevision ?? 1)" : "Ready to render"
      )
      .font(.caption2).foregroundStyle(.secondary)
    }
  }
}

struct ThumbnailComparisonView: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) private var dismiss
  let projectID: String
  @State private var feedSize = false
  @State private var editing: ThumbnailSlot?
  @State private var fullImage: ThumbnailRevision?
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        VStack(alignment: .leading, spacing: 5) {
          Text("Compare A & B").studioHeading(26)
          Text("Compare the same video title at both sizes. Select one image for upload.").font(
            .caption
          ).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Done") { dismiss() }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
      }
      if let p = m.project, p.id == projectID, let d = m.thumbnails, d.projectId == projectID,
        d.state.current.packagingVersion == p.packaging?.version
      {
        HStack {
          Text(m.packaging?.packaging.recommendedTitle ?? p.title).font(.headline).lineLimit(2)
          Spacer()
          Picker("Preview size", selection: $feedSize) {
            Text("Large").tag(false)
            Text("Feed size").tag(true)
          }
          .pickerStyle(.segmented).labelsHidden().accessibilityLabel("Preview size")
          .frame(width: 185)
        }
        if m.busy {
          HStack {
            ProgressView().controlSize(.small)
            Text(m.busyLabel).font(.caption)
            Spacer()
            Button("Cancel") { Task { await m.cancel() } }
          }
        }
        if let error = m.error { Banner(text: error, isError: true) { m.error = nil } }
        ThumbnailRecovery(document: d)
        ScrollView {
          HStack(alignment: .top, spacing: 18) {
            ForEach(d.state.current.slots) { slot in
              ThumbnailVariantCard(
                p: p, slot: slot, selected: d.state.selected, feedSize: feedSize,
                canGenerate: d.provider != nil, edit: { editing = slot },
                preview: { fullImage = $0 })
            }
          }
          if !d.state.history.isEmpty {
            DisclosureGroup("Earlier packaging") {
              ForEach(d.state.history.reversed(), id: \.packagingVersion) { previous in
                HStack {
                  Text("Packaging v\(previous.packagingVersion)").font(.caption)
                  ForEach(previous.slots) { slot in
                    if let revision = slot.current {
                      Button("Preview \(slot.id)") { fullImage = revision }.buttonStyle(
                        QuietButtonStyle())
                    }
                  }
                  Text("Previous package · read-only").font(.caption2).foregroundStyle(.secondary)
                  Spacer()
                }.padding(.top, 8)
              }
            }.padding(.top, 14)
          }
        }
        Divider()
        HStack {
          if let selected = d.state.selected {
            Label(
              "Upload: \(selected.slot) · revision \(selected.revision)",
              systemImage: "checkmark.circle.fill"
            )
            .foregroundStyle(Color.studioSuccess)
          } else {
            Text("No custom thumbnail selected.").foregroundStyle(.secondary)
          }
          Spacer()
          if p.publication == nil {
            Button("No custom thumbnail") { Task { await m.selectThumbnail(nil) } }
              .buttonStyle(QuietButtonStyle()).disabled(m.busy || d.state.selected == nil)
          }
          Button("Export A/B…") { Task { await m.exportThumbnails() } }.buttonStyle(
            QuietButtonStyle()
          )
          .disabled(m.busy || !d.state.current.slots.allSatisfy { $0.status == "READY" })
        }.font(.caption)
        Text(
          p.publication == nil
            ? "Your exact selection is included in packaging approval. A/B experiments run in YouTube Studio."
            : "Published choices are read-only. Export both images for a manual experiment in YouTube Studio."
        )
        .font(.caption2).foregroundStyle(.secondary)
      } else {
        Text("Load the current project's packaging to compare thumbnails.")
      }
    }.padding(24).frame(width: 960, height: 650).background(Color.studioBackground)
      .sheet(item: $editing) { slot in
        ThumbnailEditor(slot: slot, projectID: projectID).environmentObject(m)
      }
      .sheet(item: $fullImage) { revision in
        if let p = m.project, p.id == projectID {
          VStack(alignment: .leading, spacing: 12) {
            HStack {
              Text("Revision \(revision.revision) · \(revision.headline)").font(.headline)
              Spacer()
              Button("Done") { fullImage = nil }.keyboardShortcut(.cancelAction)
            }
            ThumbnailImage(p: p, revision: revision, headline: revision.headline)
            HStack {
              Text("1280 × 720 · \(revision.background.provider) · \(revision.background.model)")
                .font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button("Open full resolution") {
                if let url = p.url(revision.path) { NSWorkspace.shared.open(url) }
              }
              Button("Reveal") { m.reveal(p.url(revision.path)) }
            }
          }.padding(24).frame(width: 950)
        }
      }
  }
}

struct ThumbnailVariantCard: View {
  @EnvironmentObject var m: StudioModel
  let p: Project
  let slot: ThumbnailSlot
  let selected: ThumbnailSelection?
  let feedSize: Bool
  let canGenerate: Bool
  let edit: () -> Void
  let preview: (ThumbnailRevision) -> Void
  @State private var viewingRevision: Int?
  private var revision: ThumbnailRevision? {
    slot.revisions.first { $0.revision == viewingRevision } ?? slot.current
  }
  private var isSelected: Bool {
    selected?.slot == slot.id && selected?.revision == revision?.revision
  }
  private var mutable: Bool { p.publication == nil && p.status == "AWAITING_PUBLISH_APPROVAL" }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Variant \(slot.id)").font(.headline)
        Spacer()
        if isSelected {
          Label("Selected for upload", systemImage: "checkmark.circle.fill").font(.caption)
            .foregroundStyle(Color.studioSuccess)
        }
      }
      Button {
        if let revision { preview(revision) }
      } label: {
        ThumbnailImage(p: p, revision: revision, headline: slot.headline)
          .frame(maxWidth: feedSize ? 240 : .infinity)
          .overlay(alignment: .bottomTrailing) {
            if revision != nil {
              Text(timestamp(Double(p.plan?.durationFrames ?? 0) / Double(p.plan?.frameRate ?? 30)))
                .font(.caption2.monospacedDigit()).padding(4).background(
                  .black.opacity(0.85), in: RoundedRectangle(cornerRadius: 3)
                ).foregroundStyle(.white).padding(6)
            }
          }
      }.buttonStyle(.plain).frame(maxWidth: .infinity, minHeight: 225)
        .help("Open full-resolution thumbnail")
      Text(m.packaging?.packaging.recommendedTitle ?? p.title).font(.callout).fontWeight(.medium)
        .lineLimit(2)
      Text(slot.emotionalHook).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      ThumbnailStatus(slot: slot)
      if let revision, revision.revision != slot.currentRevision {
        Text("Viewing revision \(revision.revision) · export uses the current revision")
          .font(.caption2).foregroundStyle(.secondary)
      }
      if let selected, selected.slot == slot.id, !isSelected {
        Text(
          "Upload still uses revision \(selected.revision). Choose a revision below to replace it."
        )
        .font(.caption2).foregroundStyle(.secondary)
      }
      if let revision {
        HStack {
          if mutable {
            Button(isSelected ? "Selected · r\(revision.revision)" : "Use \(slot.id) for upload") {
              Task { await m.selectThumbnail(slot, revision: revision.revision) }
            }.buttonStyle(PrimaryActionButtonStyle()).disabled(m.busy || isSelected)
          }
          Button("Reveal") { m.reveal(p.url(revision.path)) }.buttonStyle(QuietButtonStyle())
        }
      }
      HStack {
        if mutable {
          Button("Edit…", action: edit).buttonStyle(QuietButtonStyle()).disabled(m.busy)
          if slot.status != "READY" {
            Button(slot.error == nil ? "Render \(slot.id)" : "Retry \(slot.id)") {
              Task { await m.renderThumbnails([slot]) }
            }
            .buttonStyle(QuietButtonStyle()).disabled(
              m.busy || (!canGenerate && slot.background == nil))
          } else {
            Button("Regenerate image") { Task { await m.regenerateThumbnail(slot) } }
              .buttonStyle(QuietButtonStyle()).disabled(m.busy || !canGenerate)
              .help("Generate one new background; existing revisions are kept")
          }
        }
      }
      if slot.revisions.count > 1 {
        Menu("Previous versions") {
          Button("Latest") { viewingRevision = nil }
          ForEach(slot.revisions.reversed()) { r in
            Button("Revision \(r.revision) · \(r.headline)") { viewingRevision = r.revision }
          }
        }.font(.caption)
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .topLeading)
      .studioCard(cornerRadius: 11)
      .overlay(
        RoundedRectangle(cornerRadius: 11).stroke(
          isSelected ? Color.studioAccent : .clear, lineWidth: 2))
  }
}

struct ThumbnailEditor: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) private var dismiss
  let slot: ThumbnailSlot
  let projectID: String
  @State private var headline: String
  @State private var direction: String
  @State private var concept: String
  @State private var discard = false
  init(slot: ThumbnailSlot, projectID: String) {
    self.slot = slot
    self.projectID = projectID
    _headline = State(initialValue: slot.headline)
    _direction = State(initialValue: slot.direction)
    _concept = State(initialValue: slot.conceptId)
  }
  private var dirty: Bool {
    headline != slot.headline || direction != slot.direction || concept != slot.conceptId
  }
  private var newImage: Bool {
    direction != slot.direction || concept != slot.conceptId || slot.background == nil
  }
  private func close() { if dirty { discard = true } else { dismiss() } }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Edit thumbnail \(slot.id)").studioHeading(24)
      if let concepts = m.packaging?.packaging.thumbnailConcepts {
        Picker("Concept", selection: $concept) {
          ForEach(concepts) { Text($0.headline).tag($0.id) }
        }
        .onChange(of: concept) { _, next in
          if let c = concepts.first(where: { $0.id == next }) {
            headline = c.headline
            direction = c.direction
          }
        }
      }
      Text("Headline · \(headline.count)/50 characters").font(.caption).foregroundStyle(.secondary)
      TextEditor(text: $headline).font(.body).scrollContentBackground(.hidden)
        .padding(6).frame(height: 64).background(.white, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))
        .accessibilityLabel("Headline")
      Text("Visual direction").font(.caption).foregroundStyle(.secondary)
      TextEditor(text: $direction).font(.body).scrollContentBackground(.hidden)
        .padding(6).frame(height: 96).background(.white, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))
        .accessibilityLabel("Visual direction")
      Text(
        newImage
          ? "This creates one new background with your configured image provider."
          : "Only the headline changes. The saved background is reused with no image-generation call."
      )
      .font(.caption).foregroundStyle(.secondary)
      if let error = m.error { Banner(text: error, isError: true) { m.error = nil } }
      HStack {
        Button("Cancel", action: close).buttonStyle(QuietButtonStyle()).disabled(m.busy)
        Spacer()
        Button(newImage ? "Render new image" : "Apply headline") {
          Task {
            guard m.selectedID == projectID else { return }
            if await m.updateThumbnail(
              slot, headline: headline, direction: direction, concept: concept)
            {
              let current = m.thumbnails?.state.current.slots.first { $0.id == slot.id }
              dismiss()
              if m.selectedID == projectID, let current { await m.renderThumbnails([current]) }
            }
          }
        }.buttonStyle(PrimaryActionButtonStyle()).disabled(
          m.busy || headline.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || headline.count > 50
            || direction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || direction.count > 600 || (newImage && m.thumbnails?.provider == nil))
      }
    }.padding(28).frame(width: 580)
      .interactiveDismissDisabled(dirty || m.busy).onExitCommand { if !m.busy { close() } }
      .confirmationDialog(
        "Discard these thumbnail edits?", isPresented: $discard, titleVisibility: .visible
      ) {
        Button("Discard edits", role: .destructive) { dismiss() }
        Button("Keep editing", role: .cancel) {}
      }
  }
}
