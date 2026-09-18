import Foundation

struct Approval: Decodable {
  let version: Int
  let approvedAt: String
  let thumbnail: ThumbnailSelection?
  /// Approvals from before the Producer existed decode as the creator's.
  let approvedBy: String?
  var by: String { approvedBy == "producer" ? "producer" : "creator" }
}
/// Deterministic Producer review of a machine gate; the persisted audit trail
/// behind every auto-approval and escalation.
struct ProducerReviewFinding: Decodable, Identifiable {
  var id: String { code + message }
  let severity: String
  let code: String
  let message: String
}
struct ProducerReviewEvidence: Decodable {
  let sentences: Int
  let omitted: Int
  let scenes: Int
  let durationSeconds: Double
  let qaStatus: String?
  let warnings: Int?
  let attention: Int?
}
struct ProducerReview: Decodable, Identifiable {
  let id: String
  let gate: String
  let planVersion: Int
  let verdict: String
  let checkedAt: String
  let reviewer: String
  let findings: [ProducerReviewFinding]
  let evidence: ProducerReviewEvidence
  var blockers: [ProducerReviewFinding] { findings.filter { $0.severity == "blocker" } }
  var warningsOnly: [ProducerReviewFinding] { findings.filter { $0.severity == "warn" } }
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
  let thumbnail: ThumbnailSelection?
  let warning: String?
  let thumbnailStatus: String?
}
struct ThumbnailSelection: Decodable {
  let packagingVersion: Int
  let slot: String
  let revision: Int
  let path: String
  let outputHash: String
}
struct ThumbnailBackground: Decodable {
  let path: String
  let provider: String
  let model: String
}
struct ThumbnailRevision: Decodable, Identifiable {
  var id: Int { revision }
  let revision: Int
  let conceptId: String
  let headline: String
  let direction: String
  let path: String
  let outputHash: String
  let createdAt: String
  let background: ThumbnailBackground
}
struct ThumbnailSlot: Decodable, Identifiable {
  let id: String
  let version: Int
  let conceptId: String
  let headline: String
  let direction: String
  let emotionalHook: String
  let status: String
  let stage: String?
  let error: String?
  let background: ThumbnailBackground?
  let currentRevision: Int?
  let revisions: [ThumbnailRevision]
  var current: ThumbnailRevision? { revisions.first { $0.revision == currentRevision } }
}
struct ThumbnailPackage: Decodable {
  let packagingVersion: Int
  let packagingHash: String
  let slots: [ThumbnailSlot]
}
struct ThumbnailState: Decodable {
  let current: ThumbnailPackage
  let history: [ThumbnailPackage]
  let selected: ThumbnailSelection?
}
struct ThumbnailDocument: Decodable {
  let projectId: String
  let state: ThumbnailState
  let provider: String?
  let model: String?
}
struct ThumbnailExport: Decodable {
  let directory: String
  let files: [String]
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
struct ArchLayer: Decodable {
  let name: String
  let components: [String]
}
/// CodeReveal renders `lines` as plain strings; Terminal renders {kind, text} rows.
enum GraphicLine: Decodable {
  case code(String)
  case terminal(kind: String, text: String)

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let line = try? container.decode(String.self) {
      self = .code(line)
      return
    }
    struct Row: Decodable {
      let kind: String
      let text: String
    }
    let row = try container.decode(Row.self)
    self = .terminal(kind: row.kind, text: row.text)
  }

  var text: String {
    switch self {
    case .code(let line): return line
    case .terminal(_, let text): return text
    }
  }
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
  let basis: String?
  let layers: [ArchLayer]?
  let failedLayer: Int?
  let method: String?
  let path: String?
  let steps: [String]?
  let failureStep: Int?
  let removed: [String]?
  let added: [String]?
  let series: [Double]?
  let threshold: Double?
  let goodDirection: String?
  let failedNode: Int?
  let recovered: Bool?
  let highlight: Int?
  let lines: [GraphicLine]?
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
  // gpt-image parameters; Blender assets carry typed 3D parameters instead.
  let brief: String?
  let style: String?
  let palette: String?
  let avoid: String?
  let quality: String?
  let expectsText: Bool?
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
struct SceneAudio: Decodable {
  let gainDb: Double
}
struct SelectionAlternate: Decodable {
  let recordingId: String
  let start: Double
  let end: Double
  let score: Double
}
struct SceneSelection: Decodable {
  let score: Double
  let bridged: Bool
  let alternates: [SelectionAlternate]?
}
struct ProductionScene: Decodable, Identifiable {
  let id: String
  let startFrame: Int
  let durationFrames: Int
  let sourceInFrame: Int
  let narration: String
  let transcriptSegmentIds: [String]?
  let audio: SceneAudio?
  let musicIntensity: Double?
  let transition: String?
  let camera: Camera
  let visual: Visual
  let broll: [BRollEntry]?
  let enabled: Bool
  let rationale: String
  let chapterTitle: String?
  let selection: SceneSelection?
}
struct CoverageSentence: Decodable {
  let text: String
  let status: String
  let sceneId: String?
  let reason: String?
}
struct ScriptCoverage: Decodable {
  let sentences: [CoverageSentence]
  var included: [CoverageSentence] { sentences.filter { $0.status == "included" } }
  var omitted: [CoverageSentence] { sentences.filter { $0.status == "omitted" } }
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
  let visualDensity: String?
  let silenceTightening: String?
  let directorPersona: String?
  let captionStyle: String?
  let audioPolish: String?
  let audioDesign: AudioDesign?
  let scriptCoverage: ScriptCoverage?
  var brollCount: Int { scenes.reduce(0) { $0 + ($1.broll?.count ?? 0) } }
  var density: String {
    ["minimal", "balanced", "rich"].contains(visualDensity ?? "")
      ? visualDensity! : "balanced"
  }
  var tightening: String {
    ["natural", "tight", "punchy"].contains(silenceTightening ?? "")
      ? silenceTightening! : "natural"
  }
  /// The hired director; legacy plans decode as the purist, matching the
  /// plan schema default so old storyboards never change meaning.
  var persona: String {
    ["purist", "craftsman", "showman"].contains(directorPersona ?? "")
      ? directorPersona! : "purist"
  }
  var captions: String {
    ["pop", "karaoke"].contains(captionStyle ?? "") ? captionStyle! : "none"
  }
  var polish: String {
    ["polished", "loud"].contains(audioPolish ?? "") ? audioPolish! : "natural"
  }
}
/// Derived punch-line captions (IPC `captions.list`); never plan data.
struct CaptionEvent: Decodable, Identifiable {
  let id: String
  let sceneId: String
  let startFrame: Int
  let endFrame: Int
  let text: String
}
struct CaptionList: Decodable {
  let style: String
  let events: [CaptionEvent]
  let skippedRecordings: [String]
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
  /// Who decided the patch; pre-Producer rows decode as the creator's.
  let decidedBy: String?
}
struct Project: Decodable, Identifiable {
  let id: String
  let title: String
  let slug: String
  let description: String
  let targetDuration: Double
  let status: String
  /// Who satisfies the machine gates; pre-Producer rows decode as supervised.
  let autonomy: String?
  let producerReviews: [ProducerReview]?
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
  let finalRenderEngine: String?
  let usage: [Usage]
  let directory: String?
  let assets: [Asset]?
  let jobs: [Job]?
  var plan: Plan? { plans.last }
  var currentBuild: Build? { builds.last { $0.planVersion == plan?.version } }
  var latestBuild: Build? { builds.last }
  var isAutonomous: Bool { autonomy == "autonomous" }
  var reviews: [ProducerReview] { producerReviews ?? [] }
  var lastProducerReview: ProducerReview? { reviews.last }
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
  let note: String?
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
struct QAMetadata: Decodable {
  let duration: Double?
  let width: Int?
  let height: Int?
  let codec: String?
  let frameRate: Double?
  let hasAudio: Bool?
  let audioCodec: String?
  let bytes: Int?
  let frames: Int?
}
struct QAAudio: Decodable {
  let silenceThresholdDb: Double?
  let minimumSilenceSeconds: Double?
  let silenceStarts: [Double]?
  let meanVolumeDb: Double?
  let maxVolumeDb: Double?
  let note: String?
}
struct QACoverage: Decodable, Identifiable {
  var id: String { recordingId }
  let recordingId: String
  let name: String
  let durationSeconds: Double
  let keptSeconds: Double
}
struct QAReport: Decodable {
  let status: String
  let checkedAt: String?
  let warnings: [String]?
  let attention: [String]?
  let humanChecks: [String]?
  let coverageNote: String?
  let checks: [String]?
  let metadata: QAMetadata?
  let audio: QAAudio?
  let coverage: [QACoverage]?
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
  var director: String = "craftsman"
  var visualDensity: String = "balanced"
  var silenceTightening: String = "natural"
  var brand: Brand
  var preferences: [Preference]
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    channel = try c.decode(String.self, forKey: .channel)
    format = try c.decode(String.self, forKey: .format)
    targetMinutes = try c.decode([Double].self, forKey: .targetMinutes)
    subjects = try c.decode([String].self, forKey: .subjects)
    // Profiles persisted before the director existed decode as the craftsman
    // default; the runtime re-derives the knobs from the persona on save.
    let persona = try c.decodeIfPresent(String.self, forKey: .director)
    director =
      ["purist", "craftsman", "showman"].contains(persona ?? "")
      ? persona! : "craftsman"
    // Profiles persisted before the knob existed decode as the default.
    let density = try c.decodeIfPresent(String.self, forKey: .visualDensity)
    visualDensity =
      ["minimal", "balanced", "rich"].contains(density ?? "")
      ? density! : "balanced"
    let tightening = try c.decodeIfPresent(
      String.self, forKey: .silenceTightening)
    silenceTightening =
      ["natural", "tight", "punchy"].contains(tightening ?? "")
      ? tightening! : "natural"
    brand = try c.decode(Brand.self, forKey: .brand)
    preferences = try c.decode([Preference].self, forKey: .preferences)
  }
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
