import Foundation
import Testing

@testable import YTAIStudio

@Test func transcriptRetakeReviewKeepsRawAttemptsAndLastDelivery() throws {
  let raw = """
    {"recordingId":"rec-1","provider":"whisper","model":"local",
     "segments":[
       {"id":"first","start":85.4,"end":93.96,"text":"Actually the quite the opposite."},
       {"id":"second","start":93.96,"end":98.24,"text":"Actually quite the opposite."},
       {"id":"last","start":98.24,"end":101,"text":"Actually quite the opposite."}
     ]}
    """
  let decoder = JSONDecoder()
  let legacy = try decoder.decode(Transcript.self, from: Data(raw.utf8))
  #expect(legacy.retakeReview == nil)
  #expect(legacy.segments.count == 3)
  var payload = try #require(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
  let segments = try #require(payload["segments"] as? [[String: Any]])
  payload["retakeReview"] = [
    "segments": [segments[2]],
    "groups": [["kept": segments[2], "discarded": Array(segments.prefix(2))]],
  ]
  let reviewed = try decoder.decode(
    Transcript.self, from: JSONSerialization.data(withJSONObject: payload))
  #expect(reviewed.segments.count == 3)
  #expect(reviewed.retakeReview?.segments.first?.start == 98.24)
  #expect(reviewed.retakeReview?.discardedCount == 2)
}

@Test func transcriptionReviewDecodesIndependentEvidenceAndPendingDecisions() throws {
  let payload = """
    {"id":"review-1","recordingId":"rec-1","candidateHash":"hash","status":"needs-review","summary":"Check words.",
     "issues":[{"id":"issue-1","kind":"wording","reason":"Recognizers disagree.","start":2,"end":5,
       "originalText":"Post grass","suggestedText":"Postgres","status":"pending",
       "proposed":[{"id":"verified-1","start":2.1,"end":4.8,"text":"Postgres"}],
       "verification":{"model":"whisper-1","text":"Postgres","alignmentCoverage":1}}]}
    """
  let review = try JSONDecoder().decode(TranscriptionReview.self, from: Data(payload.utf8))
  #expect(review.issues.first?.proposed?.first?.text == "Postgres")
  #expect(review.issues.first?.verification?.alignmentCoverage == 1)
  #expect(review.issues.first?.status == "pending")
}
