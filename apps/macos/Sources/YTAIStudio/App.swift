import AppKit
import SwiftUI

@main struct YTAIStudioApp: App {
  @StateObject private var model = StudioModel()
  var body: some SwiftUI.Scene {
    WindowGroup("YouTube-AI-Studio") {
      StudioView().environmentObject(model).frame(minWidth: 1040, minHeight: 720)
        .preferredColorScheme(.light).onAppear { model.runtime.launch() }.onReceive(
          NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)
        ) { _ in model.runtime.stop() }
    }
    .defaultSize(width: 1360, height: 900)
    .commands {
      CommandGroup(after: .appInfo) {
        Button("Show Project Folder") {
          model.reveal(model.project?.directory.map { URL(fileURLWithPath: $0) })
        }.keyboardShortcut("o", modifiers: [.command, .shift])
      }
    }
    Settings {
      SettingsView().environmentObject(model).frame(width: 740, height: 760).preferredColorScheme(
        .light
      ).tint(.studioAccent)
    }
  }
}
extension Color {
  static let studioAccent = Color(red: 0.80, green: 0.31, blue: 0.19)
  static let studioAccentSoft = Color(red: 0.80, green: 0.31, blue: 0.19).opacity(0.12)
  static let studioSuccess = Color(red: 0.18, green: 0.52, blue: 0.39)
  static let studioBackground = Color(nsColor: .windowBackgroundColor)
  static let studioSurface = Color(nsColor: .controlBackgroundColor)
  static let studioPaper = Color(nsColor: .textBackgroundColor)
  static let studioInk = Color(nsColor: .labelColor)
  static let studioBorder = Color(nsColor: .separatorColor)
}
extension View {
  func studioCard(cornerRadius: CGFloat) -> some View {
    background(Color.studioSurface, in: RoundedRectangle(cornerRadius: cornerRadius))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius)
          .strokeBorder(Color.studioBorder, lineWidth: 0.7))
  }
  func studioHeading(_ size: CGFloat) -> some View {
    font(.system(size: size, weight: .regular, design: .serif))
  }
}
struct PrimaryActionButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(.white)
      .padding(.horizontal, 16)
      .frame(height: 38)
      .background(
        Capsule().fill(isEnabled ? Color.studioAccent : Color.studioInk.opacity(0.3))
          .opacity(configuration.isPressed ? 0.78 : 1)
      )
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
struct QuietButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(isEnabled ? Color.studioInk : Color.studioInk.opacity(0.3))
      .padding(.horizontal, 12)
      .frame(height: 30)
      .background(
        Capsule()
          .fill(Color.studioSurface.opacity(configuration.isPressed ? 0.65 : 1))
          .overlay(Capsule().stroke(Color.studioBorder, lineWidth: 0.7)))
  }
}
struct StudioView: View {
  @EnvironmentObject var m: StudioModel
  @State private var newProject = false
  @State private var settings = false
  @State private var confirmDelete: Project?
  var body: some View {
    NavigationSplitView {
      VStack(alignment: .leading, spacing: 24) {
        HStack(spacing: 10) {
          Image(systemName: "rectangle.stack.badge.play.fill").font(.title2).foregroundStyle(
            Color.studioAccent)
          VStack(alignment: .leading, spacing: 3) {
            Text("YouTube AI").font(.system(size: 18, weight: .medium, design: .serif))
            Text("STUDIO").font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(
              3
            ).foregroundStyle(.secondary)
          }
        }.padding(.top, 20)
        Button {
          newProject = true
        } label: {
          Label("New Project", systemImage: "plus").frame(maxWidth: .infinity)
        }.buttonStyle(PrimaryActionButtonStyle()).disabled(m.busy)
        Button {
          m.showingAdvanceAll = true
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "wand.and.stars").foregroundStyle(Color.studioAccent)
            Text("Producer — All Projects").font(.system(size: 12, weight: .medium))
            Spacer()
            Text("\(m.projects.filter { $0.isAutonomous }.count)")
              .font(.system(size: 10, weight: .semibold, design: .monospaced))
              .foregroundStyle(.secondary)
          }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(
              m.showingAdvanceAll ? Color.studioAccent.opacity(0.10) : .clear,
              in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).help(
          "One Producer pass over every autonomous project — advance machine gates, self-recover crashed builds, stop at your script and publication gates"
        )
        Text("PRODUCTIONS").font(.system(size: 10, weight: .semibold)).tracking(2).foregroundStyle(
          .secondary)
        ScrollView {
          VStack(spacing: 7) {
            ForEach(m.projects) { p in
              Button {
                Task { await m.select(p.id) }
              } label: {
                VStack(alignment: .leading, spacing: 7) {
                  Text(p.title).font(.system(size: 13, weight: .medium)).lineLimit(3)
                    .multilineTextAlignment(.leading)
                  HStack(spacing: 5) {
                    Text(p.statusLabel).font(.system(size: 10)).foregroundStyle(
                      m.selectedID == p.id ? Color.studioAccent : Color.secondary
                    ).lineLimit(2)
                    if p.isAutonomous {
                      Image(systemName: "wand.and.stars").font(.system(size: 9))
                        .foregroundStyle(Color.studioAccent)
                        .help("Autonomous — the Producer carries the machine gates")
                    }
                    if let total = p.costs?.totalUSD, total > 0 {
                      Text("· \(money(total))").font(
                        .system(size: 10, weight: .medium, design: .monospaced)
                      )
                      .foregroundStyle(.secondary)
                    }
                  }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(
                  m.selectedID == p.id ? Color.primary.opacity(0.07) : .clear,
                  in: RoundedRectangle(cornerRadius: 10))
              }.buttonStyle(.plain).disabled(m.busy)
                .contextMenu {
                  Button(role: .destructive) {
                    confirmDelete = p
                  } label: {
                    Label("Delete Project…", systemImage: "trash")
                  }
                }
            }
          }
        }
        Spacer(minLength: 0)
        VStack(alignment: .leading, spacing: 12) {
          Label(
            m.provider == "mock" ? "Mock director · $0 API" : "OpenAI director",
            systemImage: m.provider == "mock" ? "leaf" : "sparkles"
          ).font(.caption).foregroundStyle(.secondary)
          Button {
            m.openCosts()
          } label: {
            HStack(spacing: 6) {
              Image(systemName: "dollarsign.circle")
              Text("Costs")
              Spacer()
              Text(money(m.project?.costs?.totalUSD ?? 0))
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
            }.padding(12).background(
              m.showingCosts ? Color.studioAccent.opacity(0.10) : .clear,
              in: RoundedRectangle(cornerRadius: 10))
          }.buttonStyle(.plain).disabled(m.project == nil)
            .help("Estimated API spend for this production")
          Button {
            settings = true
          } label: {
            Label("Settings & Environment", systemImage: "slider.horizontal.3")
          }.buttonStyle(.plain)
        }.padding(.bottom, 14)
      }.padding(.horizontal, 18).frame(minWidth: 220).background(Color.studioBackground)
    } detail: {
      VStack(spacing: 0) {
        if let p = m.project {
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 8) {
              Text(p.title).font(.system(size: 25, weight: .semibold))
              HStack(spacing: 12) {
                Text(p.statusLabel).foregroundStyle(Color.studioAccent)
                Text("•")
                Text("\(timestamp(p.targetDuration)) target")
                if let version = p.plan?.version { Text("• Plan v\(version)") }
              }.font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
              m.reveal(p.directory.map { URL(fileURLWithPath: $0) })
            } label: {
              Image(systemName: "folder")
            }.help("Reveal project folder")
            Button {
              confirmDelete = p
            } label: {
              Image(systemName: "trash")
            }.help("Delete project (files you imported from are untouched)")
          }.padding(28)
          HStack(spacing: 4) {
            ForEach(
              [
                "Overview", "Pre-Production", "Script", "Media", "Transcript", "Storyboard",
                "Production", "Visual QA", "Review",
              ],
              id: \.self
            ) { tab in
              Button {
                m.tab = tab
              } label: {
                Text(tab).font(.system(size: 12, weight: .medium)).padding(.horizontal, 14).padding(
                  .vertical, 10
                ).background(
                  m.tab == tab ? Color.primary.opacity(0.08) : .clear,
                  in: RoundedRectangle(cornerRadius: 8)
                ).foregroundStyle(m.tab == tab ? .primary : .secondary)
              }.buttonStyle(.plain)
            }
            Spacer()
          }.padding(.horizontal, 28).padding(.bottom, 18)
          Divider()
          statusBanners
          Group {
            switch m.tab {
            case "Pre-Production": PreproductionView(p: p)
            case "Script": ScriptView(p: p)
            case "Media": MediaView(p: p)
            case "Transcript": TranscriptView(p: p)
            case "Storyboard": StoryboardView(p: p)
            case "Production": ProductionView(p: p)
            case "Visual QA": VisualQAView(p: p)
            case "Review": ReviewView(p: p)
            default: OverviewView(p: p)
            }
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          statusBanners
          VStack(spacing: 20) {
            Image(systemName: "film.stack").font(.system(size: 50, weight: .ultraLight))
              .foregroundStyle(Color.studioAccent)
            Text("A production studio for your YouTube channel.").studioHeading(28)
            Text("Approve the script. Record your A-roll. Direct the edit.").foregroundStyle(
              .secondary)
            Button("Create a Project") { newProject = true }.buttonStyle(PrimaryActionButtonStyle())
            RuntimeStatus(runtime: m.runtime)
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }.background(Color.studioBackground)
        .confirmationDialog(
          "Delete “\(confirmDelete?.title ?? "")”?",
          isPresented: Binding(
            get: { confirmDelete != nil },
            set: { if !$0 { confirmDelete = nil } }
          ),
          titleVisibility: .visible
        ) {
          Button("Delete Project", role: .destructive) {
            guard let p = confirmDelete else { return }
            confirmDelete = nil
            Task { await m.delete(p) }
          }
          Button("Cancel", role: .cancel) { confirmDelete = nil }
        } message: {
          Text(
            confirmDelete?.recordings.isEmpty == true
              ? "Scripts, plans, renders and artifacts are removed from the library. This project has no imported A-roll."
              : "Scripts, plans, renders and the imported copies of your A-roll are removed from the library. The original files you imported from are untouched."
          )
        }
    }.tint(.studioAccent)
      .sheet(isPresented: $newProject) { NewProjectView().environmentObject(m) }
      .sheet(isPresented: $settings) {
        SettingsView().environmentObject(m).frame(width: 760, height: 780)
      }
      .sheet(isPresented: $m.showingCosts) {
        CostsSheet().environmentObject(m).frame(width: 700, height: 660)
      }
      .sheet(isPresented: $m.showingAdvanceAll) {
        AdvanceAllSheet().environmentObject(m).frame(width: 720, height: 620)
      }
      .overlay(alignment: .bottomTrailing) {
        ConnectionLoader(runtime: m.runtime, onReady: { Task { await m.load() } })
      }
  }
  /// Busy/error/notice strip shared by the project and empty states, so
  /// feedback from deleting the selected project stays visible.
  private var statusBanners: some View {
    VStack(spacing: 0) {
      if m.busy {
        HStack {
          ProgressView().controlSize(.small)
          Text(m.busyLabel).font(.caption)
          Spacer()
          Button("Cancel") { Task { await m.cancel() } }.controlSize(.small)
        }.padding(.horizontal, 28).padding(.vertical, 10).background(Color.studioAccentSoft)
      }
      if let error = m.error { Banner(text: error, isError: true) { m.error = nil } }
      if let notice = m.notice { Banner(text: notice, isError: false) { m.notice = nil } }
    }
  }
}
struct RuntimeStatus: View {
  @ObservedObject var runtime: Runtime
  var body: some View {
    Text(
      runtime.startupError
        ?? (runtime.connected ? "Local runtime connected" : "Starting local runtime…")
    ).font(.caption).foregroundStyle(runtime.startupError == nil ? Color.secondary : .orange)
      .textSelection(.enabled).padding()
  }
}
/// Cost display stays honest: sub-cent totals read "<$0.01" instead of $0.00.
func money(_ value: Double) -> String {
  value > 0 && value < 0.005 ? "<$0.01" : String(format: "$%.2f", value)
}
func costQuantityText(_ line: CostLine) -> String {
  var parts: [String] = []
  let tokens = line.inputTokens + line.outputTokens
  if tokens > 0 { parts.append("\(tokens) tokens") }
  if line.audioSeconds > 0 {
    parts.append(String(format: "%.0f s audio", line.audioSeconds))
  }
  if line.images > 0 { parts.append("\(line.images) image\(line.images == 1 ? "" : "s")") }
  return parts.isEmpty ? "no billed quantity recorded" : parts.joined(separator: " · ")
}
/// Estimated API spend: per-call usage priced by the runtime against list
/// rates. Local engines are free; unpriced models are called out, never
/// hidden inside the total.
struct CostsSheet: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) var dismiss
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 5) {
          Text("Cost estimate.").studioHeading(25)
          Text(
            "Every billed call — direction, revisions, transcription, stills, music, QA — is priced as it happens. Local engines (mock, whisper.cpp, Blender, FFmpeg) cost nothing."
          ).font(.caption).foregroundStyle(.secondary).padding(.trailing, 12)
        }
        Spacer()
        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark")
        }.buttonStyle(.plain)
      }
      if let report = m.costsReport {
        HStack(spacing: 12) {
          costCard("This production", report.project)
          costCard("Whole library", report.library)
        }
        if report.project.unpricedCalls > 0 {
          Label(
            "\(report.project.unpricedCalls) call\(report.project.unpricedCalls == 1 ? "" : "s") used a model without published pricing — the total may under-count.",
            systemImage: "exclamationmark.triangle"
          ).font(.caption).foregroundStyle(.orange)
        }
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            if !report.project.lines.isEmpty {
              Text("THIS PRODUCTION").font(.system(size: 10, weight: .semibold)).tracking(2)
                .foregroundStyle(.secondary).padding(.top, 4)
              ForEach(report.project.lines) { line in
                costRow(line)
              }
            }
            if report.productions.count > 1 {
              Text("ACROSS PRODUCTIONS").font(.system(size: 10, weight: .semibold)).tracking(2)
                .foregroundStyle(.secondary).padding(.top, 10)
              ForEach(report.productions.filter { $0.costs.totalUSD > 0 }) { production in
                HStack {
                  Text(production.title).font(.system(size: 12)).lineLimit(1)
                  Spacer()
                  Text(money(production.costs.totalUSD)).font(
                    .system(size: 12, design: .monospaced)
                  ).foregroundStyle(.secondary)
                }.padding(.vertical, 3)
              }
            }
          }.padding(.bottom, 6)
        }
        Text(
          "Estimates use published list rates (September 2026) and drift from invoices; Gemini Lyria is an unpublished estimate. \(report.project.freeCalls) local call\(report.project.freeCalls == 1 ? "" : "s") recorded at $0."
        ).font(.caption2).foregroundStyle(.secondary)
      } else {
        VStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text("Reading recorded usage…").font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }.padding(32).onAppear { Task { await m.loadCosts() } }
  }
  private func costCard(_ title: String, _ summary: CostSummary) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.system(size: 10, weight: .semibold)).tracking(2).foregroundStyle(.secondary)
      Text(money(summary.totalUSD))
        .font(.system(size: 26, weight: .medium, design: .serif)).monospacedDigit()
      Text("\(summary.calls) billed call\(summary.calls == 1 ? "" : "s")").font(.caption)
        .foregroundStyle(.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading).studioCard(cornerRadius: 12).padding(14)
  }
  private func costRow(_ line: CostLine) -> some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 2) {
        Text(line.agent.replacingOccurrences(of: "_", with: " ").capitalized)
          .font(.system(size: 12, weight: .medium))
        Text(
          "\(line.provider) · \(line.model) · \(line.calls) call\(line.calls == 1 ? "" : "s") · \(costQuantityText(line))"
        )
        .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        if line.unpricedCalls > 0 {
          Text("unpriced model — not in the total").font(.caption2).foregroundStyle(.orange)
        }
      }
      Spacer()
      Text(money(line.costUSD)).font(.system(size: 12, weight: .medium, design: .monospaced))
        .monospacedDigit().padding(.top, 2)
    }.padding(10).studioCard(cornerRadius: 10)
  }
}
struct ConnectionLoader: View {
  @ObservedObject var runtime: Runtime
  let onReady: () -> Void
  var body: some View {
    Color.clear.frame(width: 1, height: 1).onChange(of: runtime.connected) { _, value in
      if value { onReady() }
    }
  }
}
struct Banner: View {
  let text: String
  let isError: Bool
  let close: () -> Void
  var body: some View {
    HStack(alignment: .top) {
      Image(systemName: isError ? "exclamationmark.triangle" : "checkmark.circle")
      Text(text).font(.caption).textSelection(.enabled)
      Spacer()
      Button(action: close) { Image(systemName: "xmark") }.buttonStyle(.plain)
    }.padding(12).foregroundStyle(isError ? Color.orange : .studioSuccess).background(
      isError ? Color.orange.opacity(0.08) : Color.studioSuccess.opacity(0.08))
  }
}
struct NewProjectView: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) var dismiss
  @State private var title = ""
  @State private var description = ""
  @State private var minutes = 15.0
  @State private var autonomy = "supervised"
  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      Text("Start with an idea.").studioHeading(25)
      Text("Your script and recordings stay in a local project folder.").foregroundStyle(.secondary)
      TextField("Video title", text: $title).textFieldStyle(.roundedBorder)
      TextField("Creative direction / description", text: $description, axis: .vertical).lineLimit(
        4...6
      ).textFieldStyle(.roundedBorder)
      HStack {
        Text("Target duration")
        Spacer()
        TextField("Minutes", value: $minutes, format: .number).frame(width: 60)
        Text("minutes").foregroundStyle(.secondary)
      }
      VStack(alignment: .leading, spacing: 8) {
        Picker("Autonomy", selection: $autonomy) {
          Text("Supervised — every gate is yours").tag("supervised")
          Text("Autonomous — the Producer advances machine gates").tag("autonomous")
        }.pickerStyle(.radioGroup)
        Text(
          autonomy == "autonomous"
            ? "The Producer auto-approves the storyboard and rough cut and drives the build, visual pass, final render and packaging. Script and publication approval stay yours."
            : "You approve the storyboard, rough cut and packaging yourself."
        ).font(.caption).foregroundStyle(.secondary)
      }
      HStack {
        Button("Cancel") { dismiss() }.buttonStyle(QuietButtonStyle())
        Spacer()
        Button("Create Project") {
          Task {
            await m.create(
              title: title, description: description, minutes: minutes, autonomy: autonomy)
            dismiss()
          }
        }.buttonStyle(PrimaryActionButtonStyle()).disabled(
          title.trimmingCharacters(in: .whitespaces).isEmpty || minutes <= 0)
      }
    }.padding(32).frame(width: 520)
  }
}
