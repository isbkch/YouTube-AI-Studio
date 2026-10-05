import Foundation
import Testing

@testable import YTAIStudio

@Test func freeDirectorChoicesAndUnavailableProfileFallback() throws {
  #expect(directorOptions.map(\.id) == ["purist", "craftsman"])
  let payload = """
    {"name":"Creator","channel":"Technical videos","format":"Essay",
     "targetMinutes":[12,18],"subjects":[],"director":"unavailable-director",
     "brand":{"background":"#101b29","foreground":"#f2f4ed","accent":"#c8ef80","fontFamily":"Inter"},
     "preferences":[]}
    """
  let creator = try JSONDecoder().decode(Creator.self, from: Data(payload.utf8))
  #expect(creator.director == "craftsman")
}
