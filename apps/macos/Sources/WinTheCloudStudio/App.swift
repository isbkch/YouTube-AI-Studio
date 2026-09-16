import AppKit
import SwiftUI

@main struct WinTheCloudStudioApp: App {
  @StateObject private var model = StudioModel()
  var body: some SwiftUI.Scene {
    WindowGroup("WinTheCloud Studio") {
      StudioView().environmentObject(model).frame(minWidth: 1040, minHeight: 720)
        .preferredColorScheme(.dark).onAppear { model.runtime.launch() }.onReceive(
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
        .dark)
    }
  }
}
extension Color {
  static let studioAccent = Color(red: 0.78, green: 0.94, blue: 0.5)
  static let studioBackground = Color(red: 0.065, green: 0.083, blue: 0.10)
  static let studioSurface = Color(red: 0.095, green: 0.115, blue: 0.135)
}
struct StudioView: View {
  @EnvironmentObject var m: StudioModel
  @State private var newProject = false
  @State private var settings = false
  var body: some View {
    NavigationSplitView {
      VStack(alignment: .leading, spacing: 24) {
        HStack(spacing: 10) {
          Image(systemName: "rectangle.stack.badge.play.fill").font(.title2).foregroundStyle(
            Color.studioAccent)
          VStack(alignment: .leading, spacing: 3) {
            Text("WinTheCloud").font(.headline)
            Text("STUDIO").font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(
              3
            ).foregroundStyle(.secondary)
          }
        }.padding(.top, 20)
        Button {
          newProject = true
        } label: {
          Label("New Project", systemImage: "plus").frame(maxWidth: .infinity)
        }.buttonStyle(.borderedProminent).tint(.studioAccent).foregroundStyle(.black).disabled(
          m.busy)
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
                  Text(p.statusLabel).font(.system(size: 10)).foregroundStyle(
                    m.selectedID == p.id ? Color.studioAccent : Color.secondary
                  ).lineLimit(2)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(
                  m.selectedID == p.id ? Color.white.opacity(0.07) : .clear,
                  in: RoundedRectangle(cornerRadius: 10))
              }.buttonStyle(.plain).disabled(m.busy)
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
          }.padding(28)
          HStack(spacing: 4) {
            ForEach(
              ["Overview", "Script", "Media", "Transcript", "Storyboard", "Production", "Review"],
              id: \.self
            ) { tab in
              Button {
                m.tab = tab
              } label: {
                Text(tab).font(.system(size: 12, weight: .medium)).padding(.horizontal, 14).padding(
                  .vertical, 10
                ).background(
                  m.tab == tab ? Color.white.opacity(0.09) : .clear,
                  in: RoundedRectangle(cornerRadius: 8)
                ).foregroundStyle(m.tab == tab ? .white : .secondary)
              }.buttonStyle(.plain)
            }
            Spacer()
          }.padding(.horizontal, 28).padding(.bottom, 18)
          Divider().opacity(0.45)
          if m.busy {
            HStack {
              ProgressView().controlSize(.small)
              Text(m.busyLabel).font(.caption)
              Spacer()
              Button("Cancel") { Task { await m.cancel() } }.controlSize(.small)
            }.padding(.horizontal, 28).padding(.vertical, 10).background(
              Color.studioAccent.opacity(0.08))
          }
          if let error = m.error { Banner(text: error, isError: true) { m.error = nil } }
          if let notice = m.notice { Banner(text: notice, isError: false) { m.notice = nil } }
          Group {
            switch m.tab {
            case "Script": ScriptView(p: p)
            case "Media": MediaView(p: p)
            case "Transcript": TranscriptView(p: p)
            case "Storyboard": StoryboardView(p: p)
            case "Production": ProductionView(p: p)
            case "Review": ReviewView(p: p)
            default: OverviewView(p: p)
            }
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          VStack(spacing: 20) {
            Image(systemName: "film.stack").font(.system(size: 50, weight: .ultraLight))
              .foregroundStyle(Color.studioAccent)
            Text("A production studio for your ideas.").font(.system(size: 30, weight: .medium))
            Text("Approve the script. Record your A-roll. Direct the edit.").foregroundStyle(
              .secondary)
            Button("Create a Project") { newProject = true }.buttonStyle(.borderedProminent).tint(
              .studioAccent
            ).foregroundStyle(.black)
            RuntimeStatus(runtime: m.runtime)
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }.background(Color.studioBackground)
    }.tint(.studioAccent)
      .sheet(isPresented: $newProject) { NewProjectView().environmentObject(m) }
      .sheet(isPresented: $settings) {
        SettingsView().environmentObject(m).frame(width: 760, height: 780)
      }
      .overlay(alignment: .bottomTrailing) {
        ConnectionLoader(runtime: m.runtime, onReady: { Task { await m.load() } })
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
    }.padding(12).foregroundStyle(isError ? Color.orange : .studioAccent).background(
      (isError ? Color.orange : .studioAccent).opacity(0.07))
  }
}
struct NewProjectView: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) var dismiss
  @State private var title = ""
  @State private var description = ""
  @State private var minutes = 15.0
  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      Text("Start with an idea.").font(.largeTitle)
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
      HStack {
        Button("Cancel") { dismiss() }
        Spacer()
        Button("Create Project") {
          Task {
            await m.create(title: title, description: description, minutes: minutes)
            dismiss()
          }
        }.buttonStyle(.borderedProminent).tint(.studioAccent).foregroundStyle(.black).disabled(
          title.trimmingCharacters(in: .whitespaces).isEmpty || minutes <= 0)
      }
    }.padding(32).frame(width: 520)
  }
}
