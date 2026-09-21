import XCTest
@testable import BeeboKit

final class WebVTTTests: XCTestCase {
    func testParsesBasicFile() {
        let vtt = """
        WEBVTT

        1
        00:00:01.000 --> 00:00:03.500
        Hello there.

        00:00:04.000 --> 00:00:06.000 align:start position:10%
        Second line
        wraps.
        """
        let cues = WebVTT.parse(vtt)
        XCTAssertEqual(cues.count, 2)
        XCTAssertEqual(cues[0], SubtitleCue(start: 1, end: 3.5, text: "Hello there."))
        XCTAssertEqual(cues[1].start, 4)
        XCTAssertEqual(cues[1].text, "Second line\nwraps.")
    }

    func testHandlesBOMCRLFAndShortTimestamps() {
        let vtt = "\u{FEFF}WEBVTT\r\n\r\n01:02.250 --> 01:04.000\r\nShort form\r\n\r\n1:00:00.000 --> 1:00:02.000\r\nHour\r\n"
        let cues = WebVTT.parse(vtt)
        XCTAssertEqual(cues.count, 2)
        XCTAssertEqual(cues[0].start, 62.25, accuracy: 0.0001)
        XCTAssertEqual(cues[1].start, 3600, accuracy: 0.0001)
    }

    func testAcceptsSrtStyleCommas() {
        let cues = WebVTT.parse("WEBVTT\n\n00:00:01,500 --> 00:00:02,500\nComma")
        XCTAssertEqual(cues.first?.start ?? 0, 1.5, accuracy: 0.0001)
    }

    func testStripsMarkupAndDecodesEntities() {
        let cues = WebVTT.parse("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i>Tom &amp; Jerry</i> <c.yellow>&lt;3</c>&nbsp;now")
        XCTAssertEqual(cues.first?.text, "Tom & Jerry <3 now")
    }

    func testSkipsNotesStylesAndBrokenCues() {
        let vtt = """
        WEBVTT - some header

        NOTE this is a comment
        that spans lines

        STYLE
        ::cue { color: red }

        00:00:05.000 --> 00:00:04.000
        backwards

        garbage --> timing
        nope

        00:00:07.000 --> 00:00:08.000
        Kept
        """
        let cues = WebVTT.parse(vtt)
        XCTAssertEqual(cues.map(\.text), ["Kept"])
    }

    func testHeaderWithoutBlankLineStillYieldsFirstCue() {
        let cues = WebVTT.parse("WEBVTT\n00:00:01.000 --> 00:00:02.000\nFirst")
        XCTAssertEqual(cues.map(\.text), ["First"])
    }

    func testCuesAreSortedByStart() {
        let cues = WebVTT.parse("WEBVTT\n\n00:00:10.000 --> 00:00:11.000\nB\n\n00:00:01.000 --> 00:00:02.000\nA")
        XCTAssertEqual(cues.map(\.text), ["A", "B"])
    }

    func testEmptyAndGarbageInput() {
        XCTAssertTrue(WebVTT.parse("").isEmpty)
        XCTAssertTrue(WebVTT.parse("not a subtitle file").isEmpty)
    }

    func testTimelineLookup() {
        let timeline = SubtitleTimeline(cues: WebVTT.parse("""
        WEBVTT

        00:00:01.000 --> 00:00:03.000
        One

        00:00:02.000 --> 00:00:05.000
        Two

        00:00:10.000 --> 00:00:12.000
        Three
        """))
        XCTAssertEqual(timeline.count, 3)
        XCTAssertNil(timeline.text(at: 0.5))
        XCTAssertEqual(timeline.text(at: 1.5), "One")
        XCTAssertEqual(timeline.text(at: 2.5), "One\nTwo")
        XCTAssertEqual(timeline.text(at: 4.0), "Two")
        XCTAssertNil(timeline.text(at: 6.0))
        XCTAssertEqual(timeline.text(at: 10.0), "Three")
        XCTAssertNil(timeline.text(at: 12.0))
        XCTAssertNil(timeline.text(at: 999))
    }

    func testEmptyTimeline() {
        XCTAssertNil(SubtitleTimeline(cues: []).text(at: 1))
        XCTAssertTrue(SubtitleTimeline(cues: []).isEmpty)
    }
}
