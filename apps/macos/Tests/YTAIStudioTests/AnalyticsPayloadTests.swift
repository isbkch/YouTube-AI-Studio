import Foundation
import Testing

@testable import YTAIStudio

@Test func unverifiedVideoSerializesRequiredNulls() throws {
  let video = ChannelVideo(
    id: "abcdefghijk", channelId: "channel", title: "Imported", duration: nil, publicDate: nil,
    publicDateSource: "unknown", visibility: "unknown", format: "unknown", tags: [],
    excluded: false, fetchedAt: "2026-01-01", projectId: nil)
  let payload = try video.channelJSON()
  #expect(payload["duration"] is NSNull)
  #expect(payload["publicDate"] is NSNull)
  #expect(payload["projectId"] is NSNull)
  #expect(payload["title"] as? String == "Imported")
}
@Test func channelOutcomeSerializesUnspecifiedAttributionTarget() throws {
  let outcome = ChannelOutcome(
    id: "record", channelId: "channel", opportunityId: "anonymous", videoId: nil, topicId: nil,
    date: "2026-01-01", kind: "conversation", buyerFit: "uncertain",
    attribution: "channel-uncertain", note: "")
  let payload = try outcome.channelJSON()
  #expect(payload["videoId"] is NSNull)
  #expect(payload["topicId"] is NSNull)
}
@Test func clearedReviewSnoozeIsExplicitNull() throws {
  let review = ChannelReview(
    id: "review", channelId: "channel", videoId: "abcdefghijk", days: 28, decision: "inconclusive",
    lesson: "", outcomesReviewed: false, noOutcomes: false, reviewedAt: "2026-01-01",
    snoozedUntil: nil)
  #expect(try review.channelJSON()["snoozedUntil"] is NSNull)
}
