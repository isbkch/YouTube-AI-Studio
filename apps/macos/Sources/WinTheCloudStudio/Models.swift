import Foundation

struct Approval: Decodable {
  let version: Int
  let approvedAt: String
}
struct ScriptVersion: Decodable {
  let version: Int
  let text: String
}
struct ResearchSource: Decodable, Identifiable {
  var id: String { url }
  let url: String
  let title: String
}
struct ResearchSummary: Decodable {
  let notes: String
  let sources: [ResearchSource]
}
struct PrevisualizationRef: Decodable {
  let version: Int
  let scriptVersion: Int
}
struct PreproductionState: Decodable {
  let researchVersion: Int?
  let narrativeVersion: Int?
  let scriptDocVersion: Int?
  let previsualization: PrevisualizationRef?
}
struct PrevisualizationShot: Decodable, Identifiable {
  let id: String
  let sectionHeading: String
  let startSeconds: Int
  let endSeconds: Int
  let setup: String
  let direction: String
}
struct RecordingGroup: Decodable {
  let setup: String
  let shotIds: [String]
  let prep: [String]
}
struct Previsualization: Decodable {
  let scriptVersion: Int
  let summary: String
  let totalPlannedSeconds: Int
  let shots: [PrevisualizationShot]
  let recordingPlan: [RecordingGroup]
  let notes: [String]
}
struct PrevisualizationResult: Decodable {
  let snapshot: Project
  let previsualization: Previsualization
  let runSheet: String
}
struct TeleprompterDocument: Decodable {
  let scriptVersion: Int
  let runSheet: String?
  let text: String
}
struct PackagingState: Decodable {
  let version: Int?
}
struct PackagingChapter: Decodable, Identifiable {
  var id: Int { seconds }
  let seconds: Int
  let title: String
}
struct TitleCandidate: Decodable, Identifiable {
  var id: String { title }
  let title: String
  let angle: String
  let why: String
}
struct ThumbnailConcept: Decodable, Identifiable {
  let id: String
  let headline: String
  let direction: String
  let emotionalHook: String
}
struct PackagingDescription: Decodable {
  let opening: String
  let body: [String]
  let sources: [ResearchSource]
}
struct PackagingMetadata: Decodable {
  let tags: [String]
  let categoryId: String
  let visibility: String
  let language: String
  let madeForKids: Bool
}
struct VideoPackaging: Decodable {
  let titleCandidates: [TitleCandidate]
  let recommendedTitleIndex: Int
  let thumbnailConcepts: [ThumbnailConcept]
  let description: PackagingDescription
  let chapters: [PackagingChapter]
  let metadata: PackagingMetadata
  let notes: [String]
  var recommendedTitle: String {
    titleCandidates.indices.contains(recommendedTitleIndex)
      ? titleCandidates[recommendedTitleIndex].title : (titleCandidates.first?.title ?? "")
  }
}
struct PackagingDocument: Decodable {
  let version: Int
  let packaging: VideoPackaging
  let description: String
}
struct PackagingResult: Decodable {
  let snapshot: Project
  let packaging: VideoPackaging
  let description: String
}
struct Publication: Decodable {
  let videoId: String
  let url: String
  let publishedAt: String
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
  let recordingId: String
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
struct Parameters: Decodable {
  let title: String?
  let subtitle: String?
  let nodes: [String]?
  let emphasis: Int?
  let quote: String?
  let attribution: String?
  let fileName: String?
  let unit: String?
}
struct Visual: Decodable {
  let type: String
  let description: String
  let graphic: Graphic?
}
struct InsetRect: Decodable {
  let x: Double
  let y: Double
  let width: Double
}
struct BRollParameters: Decodable {
  let brief: String
  let style: String
  let palette: String?
  let avoid: String?
  let quality: String
  let expectsText: Bool
}
struct BRollAsset: Decodable {
  let engine: String
  let template: String
  let parameters: BRollParameters
}
struct BRollEntry: Decodable, Identifiable {
  let id: String
  let startFrame: Int
  let durationFrames: Int
  let placement: String
  let inset: InsetRect?
  let motion: String
  let asset: BRollAsset
  let narrationHook: String
}
struct MusicBed: Decodable {
  let trackId: String
  let gainDb: Double
  let duckToDb: Double
  let fadeInSec: Double
  let fadeOutSec: Double
}
struct SfxEvent: Decodable, Identifiable {
  let id: String
  let atFrame: Int
  let trackId: String
  let gainDb: Double
}
struct AudioDesign: Decodable {
  let music: MusicBed?
  let sfx: [SfxEvent]
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
  let broll: [BRollEntry]?
  let enabled: Bool
  let rationale: String
  let chapterTitle: String?
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
  let audioDesign: AudioDesign?
  var brollCount: Int { scenes.reduce(0) { $0 + ($1.broll?.count ?? 0) } }
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
  let imageCount: Int
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
  let research: ResearchSummary?
  let outline: [String]?
  let preproduction: PreproductionState?
  let scripts: [ScriptVersion]
  let scriptApproval: Approval?
  let recordings: [Recording]
  let transcripts: [Transcript]
  let plans: [Plan]
  let planApproval: Approval?
  let roughCutApproval: Approval?
  let packaging: PackagingState?
  let publishApproval: Approval?
  let publication: Publication?
  let revisions: [Revision]
  let builds: [Build]
  let finalRender: String?
  let usage: [Usage]
  let directory: String?
  let assets: [Asset]?
  let jobs: [Job]?
  var plan: Plan? { plans.last }
  var currentBuild: Build? { builds.last { $0.planVersion == plan?.version } }
  var latestBuild: Build? { builds.last }
  func transcript(for recording: Recording) -> Transcript? {
    transcripts.last { $0.recordingId == recording.id }
  }
  var pendingRecordings: [Recording] {
    recordings.filter { transcript(for: $0) == nil }
  }
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
struct QAFinding: Decodable {
  let kind: String
  let evidence: String
  let severity: String
}
struct QASceneVerdict: Decodable, Identifiable {
  var id: String { sceneId }
  let sceneId: String
  let verdict: String
  let findings: [QAFinding]
}
struct QAStillVerdict: Decodable, Identifiable {
  var id: String { sceneId + "/" + brollId }
  let sceneId: String
  let brollId: String
  let verdict: String
  let findings: [QAFinding]
  let note: String?
}
struct QAAnomalies: Decodable {
  let black: [QABlackInterval]?
  let frozen: [QAFreezeInterval]?
}
struct QABlackInterval: Decodable {
  let start: Double
  let end: Double
}
struct QAFreezeInterval: Decodable {
  let start: Double
}
struct QAVisual: Decodable {
  let framesDir: String?
  let reviewedBy: String?
  let summaries: [String]?
  let scenes: [QASceneVerdict]?
  let stills: [QAStillVerdict]?
  let anomalies: QAAnomalies?
}
struct QAReport: Decodable {
  let status: String
  let warnings: [String]?
  let attention: [String]?
  let humanChecks: [String]?
  let visual: QAVisual?
}
struct FinalOptions: Decodable {
  let macros: [String]
  let presets: [String]
}
struct DraftGraphic: Decodable {
  let template: String
  let reason: String
}
struct DraftScene: Decodable, Identifiable {
  let id: String
  let recordingId: String
  let start: Double
  let end: Double
  let narration: String
  let heading: String?
  let suggestedGraphic: DraftGraphic?
}
struct DroppedSentence: Decodable, Identifiable {
  var id: Int { index }
  let index: Int
  let text: String
  let reason: String
}
struct DraftStats: Decodable {
  let keptSeconds: Double
  let groups: Int
  let droppedSentences: Int
  let recordingsUsed: [String]
  let suggestedGraphics: Int
}
struct ArollDraft: Decodable {
  let scenes: [DraftScene]
  let dropped: [DroppedSentence]
  let stats: DraftStats
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
