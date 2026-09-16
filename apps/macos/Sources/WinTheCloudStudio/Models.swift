import Foundation

struct Approval: Decodable {
  let version: Int
  let approvedAt: String
}
struct ScriptVersion: Decodable {
  let version: Int
  let text: String
}
struct Recording: Decodable, Identifiable {
  let id: String
  let name: String
  let path: String
  let duration: Double
  let width: Int
  let height: Int
  let codec: String
  let frameRate: Double
  let hasAudio: Bool
  let proxyPath: String?
  let proxyStatus: String
}
struct Transcript: Decodable {
  let provider: String
  let model: String
  let segments: [Segment]
}
struct Segment: Decodable, Identifiable {
  let id: String
  let start: Double
  let end: Double
  let text: String
}
struct Graphic: Decodable {
  let engine: String
  let template: String
  let templateVersion: String
  let parameters: Parameters
}
struct Parameters: Codable {
  var title: String
  var subtitle: String
  var nodes: [String]
  var emphasis: Int
}
struct Visual: Decodable {
  let type: String
  let description: String
  let graphic: Graphic?
}
struct Camera: Decodable {
  let recordingId: String
  let framing: String
  let punchIn: Double
}
struct ProductionScene: Decodable, Identifiable {
  let id: String
  let startFrame: Int
  let durationFrames: Int
  let narration: String
  let camera: Camera
  let visual: Visual
  let enabled: Bool
  let rationale: String
}
struct Director: Decodable {
  let provider: String
  let model: String
  let summary: String
}
struct Plan: Decodable {
  let version: Int
  let frameRate: Int
  let durationFrames: Int
  let scenes: [ProductionScene]
  let director: Director
}
struct Asset: Decodable, Identifiable {
  var id: String { assetId }
  let assetId: String
  let sceneId: String?
  let productionPlanVersion: Int
  let type: String
  let template: String?
  let path: String
  let inputHash: String
  let outputHash: String
  let jobId: String
  let reused: Bool
  let renderMs: Double
}
struct StudioFailure: Decodable, Error, LocalizedError {
  let kind: String
  let message: String
  let recovery: String
  let retryable: Bool
  var errorDescription: String? { message + "\n\n" + recovery }
}
struct Job: Decodable, Identifiable {
  let id: String
  let runId: String
  let label: String
  let type: String
  let status: String
  let progress: Double
  let logs: [String]
  let error: StudioFailure?
  let retryCount: Int
}
struct Build: Decodable {
  let planVersion: Int
  let previewPath: String
  let exportPath: String
  let qaPath: String
}
struct Usage: Decodable {
  let agent: String
  let provider: String
  let model: String
  let inputTokens: Int
  let outputTokens: Int
  let audioSeconds: Double
  let costUSD: Double?
}
struct Patch: Decodable, Identifiable {
  let id: String
  let originatingRequest: String
  let rationale: String
  let affectedScenes: [String]
  let previousVersion: Int
  let resultingVersion: Int
  let operations: [JSONValue]
}
struct Revision: Decodable, Identifiable {
  var id: String { patch.id }
  let patch: Patch
  let status: String
}
struct Project: Decodable, Identifiable {
  let id: String
  let title: String
  let slug: String
  let description: String
  let targetDuration: Double
  let status: String
  let scripts: [ScriptVersion]
  let scriptApproval: Approval?
  let recordings: [Recording]
  let transcripts: [Transcript]
  let plans: [Plan]
  let planApproval: Approval?
  let roughCutApproval: Approval?
  let revisions: [Revision]
  let builds: [Build]
  let usage: [Usage]
  let directory: String?
  let assets: [Asset]?
  let jobs: [Job]?
  var plan: Plan? { plans.last }
  var currentBuild: Build? { builds.last { $0.planVersion == plan?.version } }
  var latestBuild: Build? { builds.last }
  func url(_ relative: String) -> URL? {
    directory.map { URL(fileURLWithPath: $0).appendingPathComponent(relative) }
  }
  var statusLabel: String { status.replacingOccurrences(of: "_", with: " ").capitalized }
}
struct EnvironmentCheck: Decodable, Identifiable {
  var id: String { name }
  let name: String
  let status: String
  let version: String
  let required: Bool
  let guidance: String
}
struct DoctorReport: Decodable {
  let checks: [EnvironmentCheck]
  let overall: String
}
struct ResolveReport: Decodable {
  let available: Bool
  let version: String?
  let reason: String?
  let project: String?
  let timeline: String?
}
struct Preference: Codable, Identifiable {
  let id: String
  let text: String
  let source: String
  let createdAt: String
}
struct Brand: Codable {
  var background: String
  var foreground: String
  var accent: String
  var fontFamily: String
}
struct Creator: Codable {
  var name: String
  var channel: String
  var format: String
  var targetMinutes: [Double]
  var subjects: [String]
  var brand: Brand
  var preferences: [Preference]
}
struct AnyResponse: Decodable {}
enum JSONValue: Codable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode([String: JSONValue].self) {
      self = .object(v)
    } else {
      self = .array(try c.decode([JSONValue].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  var pretty: String {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys]
    return (try? String(data: e.encode(self), encoding: .utf8)) ?? ""
  }
}
func timestamp(_ seconds: Double) -> String {
  let s = max(0, Int(seconds))
  return String(format: "%02d:%02d", s / 60, s % 60)
}
