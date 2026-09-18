import AppKit
import Foundation
import SwiftUI

struct AnalyticsChannel: Codable, Identifiable {
  var id: String
  var title: String
  var mode: String
  var connected: Bool
  var verifiedAt: String?
  var lastSync: String?
  var status: String
  var catalogComplete: Bool
}
struct ChannelStrategy: Codable {
  var version = 0
  var objective = "Business leads and authority"
  var buyer = ""
  var problem = ""
  var expertise = ""
  var offer = ""
  var cta = ""
  var subjects: [String] = []
  var allowRemoteAnalysis = false
  var shareOutcomes = false
  var apiApprovalReference = ""
}
struct ChannelVideo: Codable, Identifiable {
  var id: String
  var channelId: String
  var title: String
  var duration: Double?
  var publicDate: String?
  var publicDateSource: String
  var visibility: String
  var format: String
  var tags: [String]
  var excluded: Bool
  var fetchedAt: String
  var projectId: String?
}
struct ChannelMetric: Codable, Identifiable {
  var id: String { name }
  let name: String
  let value: Double?
  let state: String
  let unit: String
  var label: String {
    [
      "views": "Views", "watchMinutes": "Watch time",
      "averageViewDuration": "Average view duration",
      "averageViewPercentage": "Average viewed", "subscribersGained": "Subscribers gained",
      "subscribersLost": "Subscribers lost", "impressions": "Thumbnail impressions",
      "ctr": "Thumbnail CTR",
    ][name] ?? name
  }
  var display: String {
    guard let value else { return "— · \(state)" }
    let number = value.formatted(.number.precision(.fractionLength(unit == "count" ? 0 : 1)))
    return number + (["percent": "%", "seconds": " s", "minutes": " min"][unit] ?? "")
  }
}
struct ChannelReport: Codable, Identifiable {
  struct Detail: Codable {
    let label: String
    let value: Double
  }
  let id: String
  let videoId: String
  let channelId: String
  let source: String
  let family: String
  let start: String
  let end: String
  let through: String?
  let fetchedAt: String
  let timezone: String
  let filters: String
  let coverage: String
  let metrics: [ChannelMetric]
  let details: [Detail]
  let sourceId: String
}
struct ChannelTopic: Codable, Identifiable {
  var id: String
  var channelId: String
  var title: String
  var buyer: String
  var thesis: String
  var proof: String
  var cta: String
  var rationale: String
  var counterEvidence: String
  var hypothesis: String
  var kind: String
  var evidenceLabel: String
  var evidenceIds: [String]
  var targetDuration: Int
  var batchId: String
  var version: Int
  var createdAt: String
  var status: String
  var reason: String
  var projectId: String?
  var strategyVersion: Int
  var inputHash: String
  var provider: String
  var evidenceUnavailable: Bool
}
struct ChannelOutcome: Codable, Identifiable {
  var id: String
  var channelId: String
  var opportunityId: String
  var videoId: String?
  var topicId: String?
  var date: String
  var kind: String
  var buyerFit: String
  var attribution: String
  var note: String
}
struct ChannelReview: Codable, Identifiable {
  var id: String
  var channelId: String
  var videoId: String
  var days: Int
  var decision: String
  var lesson: String
  var outcomesReviewed: Bool
  var noOutcomes: Bool
  var reviewedAt: String
  var snoozedUntil: String?
}
struct ReviewQueueItem: Decodable, Identifiable {
  let id: String
  let videoId: String
  let title: String
  let days: Int
  let end: String
  let state: String
  let hypothesis: String
  let review: ChannelReview?
}
struct AnalyticsSnapshot: Decodable {
  let channels: [AnalyticsChannel]
  let channel: AnalyticsChannel?
  let strategy: ChannelStrategy
  let videos: [ChannelVideo]
  let reports: [ChannelReport]
  let topics: [ChannelTopic]
  let latestBatchId: String?
  let outcomes: [ChannelOutcome]
  let reviews: [ChannelReview]
  let queue: [ReviewQueueItem]
  let analysisAllowed: Bool
  let evidenceHash: String
  let notices: [String]
}
struct ChannelImportPreview: Decodable {
  let token: String
  let headers: [String]
  let mapping: [String: String]
  let rowCount: Int
  let totalsSkipped: Int
  let warnings: [String]
  let videoTitles: [String]
  let duplicate: Bool
  let overlapping: Int
}
struct OAuthCandidate: Decodable {
  struct Channel: Decodable, Identifiable {
    let id: String
    let title: String
  }
  let sessionId: String
  let channels: [Channel]
}
extension Encodable {
  func channelJSON() throws -> [String: Any] {
    var result =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as? [String: Any] ?? [:]
    let nullable: [String]
    switch self {
    case is ChannelVideo: nullable = ["duration", "publicDate", "projectId"]
    case is ChannelOutcome: nullable = ["videoId", "topicId"]
    case is ChannelReview: nullable = ["snoozedUntil"]
    case is ChannelTopic: nullable = ["projectId"]
    default: nullable = []
    }
    for key in nullable where result[key] == nil { result[key] = NSNull() }
    return result
  }
}
@MainActor final class ChannelModel: ObservableObject {
  let runtime: Runtime
  @Published var snapshot: AnalyticsSnapshot?
  @Published var channelId: String?
  @Published var busy = false
  @Published var progress = ""
  @Published var error: String?
  @Published var notice: String?
  @Published var tab = "Next Topics"
  @Published var topicFilter = "proposed"
  @Published var selectedTopic: String?
  @Published var candidate: OAuthCandidate?
  private var requestID: String?
  private var oauthSession: String?
  private var autoRefreshed = Set<String>()
  init(runtime: Runtime) { self.runtime = runtime }
  func load() async {
    let requested = channelId
    do {
      let result: AnalyticsSnapshot = try await runtime.call(
        "analytics.snapshot", requested.map { ["channelId": $0] } ?? [:])
      guard requested == channelId else { return }
      snapshot = result
      channelId = result.channel?.id
    } catch { self.error = error.localizedDescription }
  }
  func open() async {
    await load()
    if let c = snapshot?.channel, c.connected, !autoRefreshed.contains(c.id) {
      autoRefreshed.insert(c.id)
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      let last = c.lastSync.flatMap { formatter.date(from: $0) } ?? .distantPast
      if Date().timeIntervalSince(last) > 86400 {
        await perform("analytics.sync", label: "Refreshing YouTube data")
      }
    }
  }
  @discardableResult
  func perform(_ method: String, label: String, params: [String: Any] = [:]) async -> Bool {
    guard !busy else { return false }
    busy = true
    error = nil
    notice = nil
    progress = label
    let request = UUID().uuidString
    requestID = request
    var args = params
    if let channelId { args["channelId"] = channelId }
    defer {
      busy = false
      requestID = nil
    }
    do {
      let _: AnyResponse = try await runtime.call(method, args, id: request)
      notice = label + " completed."
      await load()
      return true
    } catch {
      self.error = error.localizedDescription
      await load()
      return false
    }
  }
  func sample() async {
    guard !busy else { return }
    busy = true
    error = nil
    notice = nil
    defer { busy = false }
    do {
      let result: AnalyticsSnapshot = try await runtime.call("analytics.sample")
      snapshot = result
      channelId = result.channel?.id
    } catch { self.error = error.localizedDescription }
  }
  func switchChannel(_ id: String) async {
    guard !busy else { return }
    channelId = id
    selectedTopic = nil
    topicFilter = "proposed"
    notice = nil
    error = nil
    snapshot = nil
    await open()
  }
  func cancel() async {
    if let requestID {
      let _: AnyResponse? = try? await runtime.call("request.cancel", ["requestId": requestID])
    }
    if let oauthSession {
      let _: AnyResponse? = try? await runtime.call(
        "analytics.connection.cancel", ["sessionId": oauthSession])
      self.oauthSession = nil
    }
    candidate = nil
  }
  func connect(clientPath: String?) async {
    guard !busy else { return }
    busy = true
    error = nil
    progress = "Complete Google sign-in in your browser"
    defer {
      busy = false
      requestID = nil
    }
    do {
      if let clientPath {
        let _: AnyResponse = try await runtime.call(
          "analytics.connection.configure", ["path": clientPath])
      }
      struct Start: Decodable {
        let sessionId: String
        let url: String
      }
      let start: Start = try await runtime.call("analytics.connection.begin")
      oauthSession = start.sessionId
      guard let url = URL(string: start.url), url.host == "accounts.google.com" else {
        throw URLError(.badURL)
      }
      NSWorkspace.shared.open(url)
      let request = UUID().uuidString
      requestID = request
      candidate = try await runtime.call(
        "analytics.connection.finish", ["sessionId": start.sessionId], id: request)
    } catch {
      self.error = error.localizedDescription
      await cancel()
    }
  }
  func confirm(_ channel: OAuthCandidate.Channel) async {
    guard let candidate, !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let result: AnalyticsSnapshot = try await runtime.call(
        "analytics.connection.confirm", ["sessionId": candidate.sessionId, "channelId": channel.id])
      snapshot = result
      channelId = channel.id
      self.candidate = nil
      oauthSession = nil
    } catch { self.error = error.localizedDescription }
  }
}
