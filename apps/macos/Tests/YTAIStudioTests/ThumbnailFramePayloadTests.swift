import Foundation
import Testing

@testable import YTAIStudio

/// Payload tests for expressive-frame thumbnails (`thumbnails.frames` /
/// `thumbnails.setFrame`). Inline JSON mirrors what ipc.ts returns.
@Test func thumbnailFramesDocumentDecodesCandidates() throws {
  let json = """
    {"projectId":"proj-1","planVersion":4,"cached":false,
     "frames":[
       {"id":"frame-1","seconds":212.4,"timecode":"3:32","captionText":"That's why the index stays sorted.",
        "loudnessDb":-14.2,"path":"packaging/thumbnails/frames/frame-0001.jpg","hash":"abc123"},
       {"id":"frame-2","seconds":480,"timecode":"8:00","captionText":null,
        "loudnessDb":null,"path":"packaging/thumbnails/frames/frame-0002.jpg","hash":"def456"}]}
    """
  let document = try JSONDecoder().decode(
    ThumbnailFramesDocument.self, from: Data(json.utf8))
  #expect(document.projectId == "proj-1")
  #expect(document.cached == false)
  #expect(document.frames.count == 2)
  #expect(document.frames[0].timecode == "3:32")
  #expect(document.frames[0].captionText?.contains("index") == true)
  #expect(document.frames[0].loudnessDb == -14.2)
  // Chapter beats carry no caption and no loudness reading.
  #expect(document.frames[1].captionText == nil)
  #expect(document.frames[1].loudnessDb == nil)
}

@Test func thumbnailBackgroundDecodesFrameSourceAndLegacyGeneratedRows() throws {
  let frameBased = """
    {"path":"packaging/thumbnails/frames/frame-0001.jpg","hash":"abc123",
     "inputHash":"k1","provider":"video-frame","model":"final-render",
     "source":"frame","frameId":"frame-1","frameSeconds":212.4}
    """
  let frame = try JSONDecoder().decode(
    ThumbnailBackground.self, from: Data(frameBased.utf8))
  #expect(frame.isFrame)
  #expect(frame.frameId == "frame-1")
  #expect(frame.frameSeconds == 212.4)
  // Legacy generated backgrounds predate the source field entirely.
  let legacy = """
    {"path":"packaging/thumbnails/p1/A/r1/background-x.png","hash":"def456",
     "inputHash":"k2","provider":"image_generation","model":"gpt-image-1"}
    """
  let generated = try JSONDecoder().decode(
    ThumbnailBackground.self, from: Data(legacy.utf8))
  #expect(!generated.isFrame)
  #expect(generated.frameId == nil)
}
