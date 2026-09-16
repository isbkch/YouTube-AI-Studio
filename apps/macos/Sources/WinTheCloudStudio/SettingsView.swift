import SwiftUI

struct SettingsView: View {
  @EnvironmentObject var m: StudioModel
  @Environment(\.dismiss) var dismiss
  @State private var key = ""
  @State private var keySaved = false
  @State private var creator: Creator?
  @State private var preference = ""
  @State private var creatorJSON = ""
  @AppStorage("nodePath") private var nodePath = ""
  @AppStorage("projectRoot") private var projectRoot = ""
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        HStack {
          Text("Studio Settings").font(.largeTitle)
          Spacer()
          Button("Done") { dismiss() }
        }
        VStack(alignment: .leading, spacing: 14) {
          Text("Director & transcription").font(.title3)
          Picker("Provider", selection: $m.provider) {
            Text("Mock · no API credits").tag("mock")
            Text("OpenAI · billed to your API account").tag("openai")
          }.pickerStyle(.segmented)
          TextField("Director model", text: $m.modelName)
          SecureField("OpenAI API key", text: $key)
          HStack {
            Button("Save Key in Keychain") {
              do {
                try Keychain.save(key.trimmingCharacters(in: .whitespacesAndNewlines))
                key = ""
                keySaved = true
                Task { await m.diagnose() }
              } catch { m.error = error.localizedDescription }
            }.disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if keySaved {
              Label("Saved securely", systemImage: "checkmark.shield").font(.caption)
                .foregroundStyle(Color.studioAccent)
            }
            Spacer()
            Button("Apply Provider") { Task { await m.configureProvider() } }.disabled(
              !m.runtime.connected || m.busy)
          }
          Text(
            "OpenAI sends the approved script and transcript for planning, and extracted audio for transcription. The key stays in macOS Keychain and is passed only to the private local runtime. Imported transcripts and mock direction are available offline."
          ).font(.caption).foregroundStyle(.secondary)
        }.padding(20).background(Color.studioSurface, in: RoundedRectangle(cornerRadius: 12))
        VStack(alignment: .leading, spacing: 14) {
          HStack {
            Text("Environment").font(.title3)
            Spacer()
            Text(m.report?.overall ?? "Checking…").font(.caption).foregroundStyle(
              Color.studioAccent)
            Button("Check Again") { Task { await m.diagnose() } }.disabled(!m.runtime.connected)
          }
          RuntimeStatus(runtime: m.runtime)
          ForEach(m.report?.checks ?? []) { c in
            DisclosureGroup {
              Text(c.guidance).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            } label: {
              HStack {
                Text(c.name).frame(width: 140, alignment: .leading)
                Text(c.version).lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary)
                Spacer()
                Text(c.status).font(.system(size: 9, weight: .medium, design: .monospaced))
                  .foregroundStyle(
                    c.status == "AVAILABLE"
                      ? Color.studioAccent : c.required ? Color.orange : Color.secondary)
              }
            }
          }
          TextField("Node executable path (optional)", text: $nodePath)
          TextField("Project library path (optional)", text: $projectRoot)
          Text(
            "Path changes take effect after restarting the app. Existing libraries remain in their original folders."
          ).font(.caption).foregroundStyle(.secondary)
          Button("Test Resolve Scripting") {
            Task {
              do {
                let r: ResolveReport = try await m.runtime.call("resolve.probe")
                m.notice = r.available ? "Connected to Resolve \(r.version ?? "")." : r.reason
              } catch { m.error = error.localizedDescription }
            }
          }.disabled(!m.runtime.connected)
        }.padding(20).background(Color.studioSurface, in: RoundedRectangle(cornerRadius: 12))
        VStack(alignment: .leading, spacing: 14) {
          Text("Creator profile & explicit preferences").font(.title3)
          Text(
            "Defaults apply to newly created projects. Existing projects retain the profile used for their production decisions."
          ).font(.caption).foregroundStyle(.secondary)
          if let creator {
            Text("\(creator.name) / \(creator.channel)").font(.headline)
            ForEach(creator.preferences) { pref in
              Text("• " + pref.text).font(.caption).foregroundStyle(.secondary)
            }
          }
          TextField("Add a deliberate creative preference", text: $preference, axis: .vertical)
            .lineLimit(2...4)
          Button("Save Preference") {
            Task {
              do {
                creator = try await m.runtime.call("preference.add", ["text": preference])
                preference = ""
                updateJSON()
              } catch { m.error = error.localizedDescription }
            }
          }.disabled(
            preference.trimmingCharacters(in: .whitespaces).isEmpty || !m.runtime.connected)
          DisclosureGroup("Edit creator profile JSON") {
            TextEditor(text: $creatorJSON).font(.system(size: 11, design: .monospaced)).frame(
              height: 250)
            Button("Save Profile") {
              Task {
                do {
                  let profile = try JSONSerialization.jsonObject(with: Data(creatorJSON.utf8))
                  creator = try await m.runtime.call("creator.save", ["profile": profile])
                  updateJSON()
                } catch { m.error = error.localizedDescription }
              }
            }
          }
        }.padding(20).background(Color.studioSurface, in: RoundedRectangle(cornerRadius: 12))
        if let error = m.error { Banner(text: error, isError: true) { m.error = nil } }
        if let notice = m.notice { Banner(text: notice, isError: false) { m.notice = nil } }
      }.padding(28)
    }.textFieldStyle(.roundedBorder).background(Color.studioBackground).task {
      if m.runtime.connected {
        await m.diagnose()
        creator = try? await m.runtime.call("creator.get")
        updateJSON()
      }
    }
  }
  private func updateJSON() {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let creator, let data = try? encoder.encode(creator) {
      creatorJSON = String(decoding: data, as: UTF8.self)
    }
  }
}
