import Foundation
import XCTest
@testable import BeeboKit

final class MockTransport: HTTPTransport, @unchecked Sendable {
    struct Route {
        let host: String?
        let method: String?
        let path: String
        let status: Int
        let body: String
    }

    private let lock = NSLock()
    private var routes: [Route] = []
    private var recorded: [URLRequest] = []

    var requests: [URLRequest] {
        lock.withLock { recorded }
    }

    func route(_ path: String, host: String? = nil, method: String? = nil, status: Int = 200, body: String) {
        lock.withLock {
            routes.removeAll { $0.path == path && $0.method == method && $0.host == host }
            routes.append(Route(host: host, method: method, path: path, status: status, body: body))
        }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let match = record(request)
        guard let match else { throw URLError(.cannotConnectToHost) }
        let response = HTTPURLResponse(url: request.url!, statusCode: match.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (Data(match.body.utf8), response)
    }

    private func record(_ request: URLRequest) -> Route? {
        lock.withLock {
            recorded.append(request)
            let path = request.url?.path ?? ""
            let host = request.url?.host
            let method = request.httpMethod ?? "GET"
            return routes.last { ($0.method == nil || $0.method == method) && $0.path == path && ($0.host == nil || $0.host == host) }
        }
    }

    func requests(to path: String) -> [URLRequest] {
        requests.filter { $0.url?.path == path }
    }

    func jsonBody(of request: URLRequest) -> [String: Any] {
        guard let body = request.httpBody,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return [:] }
        return object
    }
}

enum Fixtures {
    static let base = URL(string: "http://192.168.1.20:47811")!

    static func api(_ transport: MockTransport, token: String? = "tok") -> BeeboAPI {
        BeeboAPI(baseURL: base, token: token, transport: transport)
    }

    static let movieOne = """
    {"id":"QWxpZW4","title":"Alien","year":1979,"overview":"In space no one can hear you scream.","tmdbId":348,
     "voteAverage":8.1,"quality":"1080p","genres":[{"id":27,"name":"Horror"}],
     "collection":{"id":8091,"name":"Alien Collection"},"isNew":false,
     "poster":"/media/poster/348.jpg","backdrop":"https://image.tmdb.org/t/p/w780/x.jpg"}
    """

    static func moviePage(total: Int, offset: Int, ids: [String]) -> String {
        let items = ids.map { "{\"id\":\"\($0)\",\"title\":\"Movie \($0)\",\"year\":2001,\"poster\":\"/media/poster/\($0).jpg\"}" }
        return "{\"ok\":true,\"apiVersion\":1,\"total\":\(total),\"limit\":60,\"offset\":\(offset),\"items\":[\(items.joined(separator: ","))]}"
    }

    static let playbackInfo = """
    {"ok":true,"kind":"movie","id":"QWxpZW4","durationSec":7020.5,
     "video":{"codec":"hevc","width":3840,"height":2160,"hdr":true},
     "qualities":[{"id":"1080p","label":"1080p","height":1080,"videoKbps":8000,"upscale":false},
                  {"id":"720p","label":"720p","height":720,"videoKbps":4000,"upscale":false},
                  {"id":"480p","label":"480p","height":480,"videoKbps":1500,"upscale":false}],
     "transcode":{"available":true,"encoder":"h264_nvenc","encoderLabel":"NVIDIA graphics card","hardware":true,"reason":""},
     "audio":[{"ordinal":0,"streamIndex":1,"label":"English 5.1","language":"en","codec":"eac3","channels":6,"isDefault":true},
              {"ordinal":1,"streamIndex":2,"label":"French","language":"fr","codec":"aac","channels":2,"isDefault":false}],
     "subtitles":[{"key":"side:0","source":"sidecar","kind":"text","label":"English","language":"en","forced":false,"url":"/subtitles/file?kind=movie&id=QWxpZW4&i=0&mt=1.abc"},
                  {"key":"emb:5","source":"embedded","kind":"image","label":"French (PGS)","language":"fr","streamIndex":5,"forced":false,"url":""}],
     "prefs":{"quality":"auto","audioLanguage":"","subtitleLanguage":"","subtitlesOn":false}}
    """

    static let startOK = """
    {"ok":true,"url":"/hls/TICKET123/index.m3u8","ticket":"TICKET123","mimeType":"application/x-mpegURL",
     "quality":"1080p","height":1080,"videoKbps":8000,"durationSec":7020.5}
    """
}

func decode<T: Decodable>(_ type: T.Type, _ json: String, file: StaticString = #filePath, line: UInt = #line) -> T {
    do {
        return try JSONDecoder().decode(T.self, from: Data(json.utf8))
    } catch {
        XCTFail("decode \(T.self) failed: \(error)", file: file, line: line)
        fatalError("decode failed")
    }
}
