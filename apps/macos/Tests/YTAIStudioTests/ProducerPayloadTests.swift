import Foundation
import Testing

@testable import YTAIStudio

/// Payload tests for the Producer's newer IPC surfaces: deterministic-v2
/// reviews (approve-with-evidence), the library-wide advance pass, and the
/// sentence-level pickup list. Inline JSON mirrors what ipc.ts returns.
@Test func producerReviewDecodesApprovedWithWarningsAndLegacyRows() throws {
  let v2 = """
    {"id":"producer-review-1","gate":"rough-cut","planVersion":3,"verdict":"approved",
     "checkedAt":"2026-09-18T10:00:00.000Z","reviewer":"deterministic-v2",
     "findings":[
       {"severity":"info","code":"sources.validated","message":"Passed validateSources."},
       {"severity":"warn","code":"audio.silence","message":"2 silence interval(s) of 2 seconds or more in the mixed cut."}],
     "evidence":{"sentences":12,"omitted":0,"scenes":7,"durationSeconds":487.2,
       "qaStatus":"PASS","warnings":2,"attention":0,
       "approvedWithWarnings":["audio.silence","transcript.mock"]}}
    """
  let review = try JSONDecoder().decode(ProducerReview.self, from: Data(v2.utf8))
  #expect(review.verdict == "approved")
  #expect(review.evidence.approvedWithWarnings == ["audio.silence", "transcript.mock"])
  #expect(review.warningsOnly.count == 1)
  // A v1 row without the field still decodes as "approved with nothing".
  let legacy = """
    {"id":"producer-review-2","gate":"storyboard","planVersion":1,"verdict":"escalated",
     "checkedAt":"2026-09-18T09:00:00.000Z","reviewer":"deterministic-v1",
     "findings":[{"severity":"blocker","code":"coverage.omissionRatio","message":"33% omitted."}],
     "evidence":{"sentences":3,"omitted":1,"scenes":2,"durationSeconds":42}}
    """
  let old = try JSONDecoder().decode(ProducerReview.self, from: Data(legacy.utf8))
  #expect(old.evidence.approvedWithWarnings == nil)
  #expect(old.blockers.first?.code == "coverage.omissionRatio")
}

@Test func advanceAllOutcomesDecodeWithHumanStopLabels() throws {
  let payload = """
    [
      {"id":"proj-1","title":"Postgres indexes","stopped":"publication",
       "acted":["storyboard v2 approved","build v2","packaging generated"],"failed":null},
      {"id":"proj-2","title":"CRDTs explained","stopped":"storyboard-escalated",
       "acted":["storyboard repair: re-directed v1 at tight pacing"],"failed":null},
      {"id":"proj-3","title":"Pickup flow","stopped":"failed","acted":[],
       "failed":{"reason":"Production failed: recording file missing."}},
      {"id":"proj-4","title":"On deck","stopped":"idle","acted":[],"failed":null}
    ]
    """
  let outcomes = try JSONDecoder().decode([AdvanceAllOutcome].self, from: Data(payload.utf8))
  #expect(outcomes.count == 4)
  #expect(outcomes[0].stoppedLabel == "Waiting at the publication gate — yours")
  // The publication gate is permanently the creator's: it reads as a
  // needs-you stop, visually distinct via its own icon.
  #expect(outcomes[0].needsYou)
  #expect(outcomes[1].stoppedLabel == "Storyboard escalated to you")
  #expect(outcomes[1].needsYou)
  #expect(outcomes[1].acted.first?.contains("repair") == true)
  #expect(outcomes[2].failed?.reason.contains("recording file") == true)
  #expect(outcomes[2].needsYou)
  #expect(outcomes[3].stoppedLabel == "Idle — nothing to advance")
  #expect(!outcomes[3].needsYou)
}

@Test func rerecordListDecodesPickupsWithContext() throws {
  let withPlan = """
    {"projectId":"proj-1","scriptVersion":2,"planVersion":4,"sentences":14,"included":12,
     "omitted":[
       {"id":"sent-007","index":6,"heading":"Index internals","text":"B-trees rebalance lazily.",
        "reason":"No take matched this sentence.",
        "before":"Postgres keeps every index in order.","after":"That laziness is why inserts stay cheap."}],
     "next":"Record the listed sentence(s) as one pickup take, import and transcribe it, then re-run plan generation; the alignment splices the pickup in across takes."}
    """
  let list = try JSONDecoder().decode(RerecordList.self, from: Data(withPlan.utf8))
  #expect(list.planVersion == 4)
  #expect(list.omitted.count == 1)
  #expect(list.omitted.first?.before?.contains("Postgres") == true)
  #expect(list.omitted.first?.after?.contains("cheap") == true)
  #expect(list.next.contains("pickup take"))
  // Before any plan exists the list still works; planVersion decodes as null.
  let early = """
    {"projectId":"proj-1","scriptVersion":1,"planVersion":null,"sentences":3,"included":2,
     "omitted":[{"id":"sent-002","index":1,"heading":null,"text":"Second thought was never recorded.",
        "reason":"No take matched this sentence (no plan generated yet).","before":null,"after":null}],
     "next":"Record the listed sentence(s) as one pickup take, import and transcribe it, then re-run plan generation; the alignment splices the pickup in across takes."}
    """
  let prePlan = try JSONDecoder().decode(RerecordList.self, from: Data(early.utf8))
  #expect(prePlan.planVersion == nil)
  #expect(prePlan.omitted.first?.heading == nil)
}
