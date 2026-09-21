import Foundation

/// What this Apple device can decode and show. The app target reads the real values from AVFoundation, VideoToolbox and
/// UIScreen (`App/Shared/DeviceCapabilitiesProbe.swift`) and hands them in here, so everything below is plain Foundation and
/// unit tested without a device.
public struct DeviceCapabilities: Equatable, Sendable {
    public enum Platform: String, Sendable {
        case tvOS = "appletv"
        case iOS = "ios"
    }

    public var platform: Platform
    /// Shown to the owner in the server's device list (short, plain).
    public var deviceName: String
    /// `VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC)`. Also stands for "a 4K-class device" (Main 10, level 5.1).
    public var hardwareHEVC: Bool
    /// `VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1)` (only newer chips).
    public var hardwareAV1: Bool
    /// `AVPlayer.availableHDRModes` contains `.hdr10` / `.hlg` / `.dolbyVision`: the connected screen accepts it right now.
    public var hdr10: Bool
    public var hlg: Bool
    public var dolbyVision: Bool
    /// 2160 for a 4K output / screen, otherwise 1080.
    public var maxHeight: Int
    /// The audio route's channel count (`AVAudioSession.maximumOutputNumberOfChannels`); 2 when unknown.
    public var outputChannels: Int
    /// The current audio route renders Dolby Atmos (spatial audio is available on it).
    public var spatialAudio: Bool

    public init(
        platform: Platform,
        deviceName: String = "",
        hardwareHEVC: Bool = false,
        hardwareAV1: Bool = false,
        hdr10: Bool = false,
        hlg: Bool = false,
        dolbyVision: Bool = false,
        maxHeight: Int = 1080,
        outputChannels: Int = 2,
        spatialAudio: Bool = false
    ) {
        self.platform = platform
        self.deviceName = deviceName
        self.hardwareHEVC = hardwareHEVC
        self.hardwareAV1 = hardwareAV1
        self.hdr10 = hdr10
        self.hlg = hlg
        self.dolbyVision = dolbyVision
        self.maxHeight = maxHeight
        self.outputChannels = outputChannels
        self.spatialAudio = spatialAudio
    }
}

/// The capability declaration sent in the body of `POST /api/playback/negotiate` (`deviceProfile`; format owned by
/// desktop/apps/desktop/electron/deviceProfile.js, described in docs/HOME-THEATER.md). The server trusts it, so every value
/// is a true statement about this device:
///  * HDR only when the screen reported it; Dolby Vision as profiles 5 and 8 (what AVPlayer plays), never profile 7;
///    HDR10+ is never claimed (no API reports it);
///  * TrueHD, DTS, DTS-HD and DTS:X are never listed (AVPlayer plays none of them);
///  * Atmos (E-AC-3 JOC) only when the audio route renders it;
///  * containers are MP4 and MOV, never Matroska; streaming is HLS (fragmented MP4 and MPEG-TS);
///  * a codec the hardware cannot decode is not listed (HEVC and AV1 follow VideoToolbox).
public enum DeviceProfile {
    public static let version = 1

    /// A declaration with nothing but the client name: the server then uses its own default for the platform.
    public static func bare(_ platform: DeviceCapabilities.Platform) -> [String: Any] {
        ["v": version, "client": platform.rawValue]
    }

    public static func declaration(_ caps: DeviceCapabilities) -> [String: Any] {
        var profile: [String: Any] = ["v": version, "client": caps.platform.rawValue]
        let name = caps.deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { profile["name"] = String(name.prefix(60)) }

        var video: [String: Any] = [
            "h264": [
                "profiles": ["baseline", "main", "high"],
                "maxLevel": caps.hardwareHEVC ? 52 : 42,
                "bitDepths": [8],
            ] as [String: Any],
        ]
        if caps.hardwareHEVC {
            video["hevc"] = ["profiles": ["main", "main10"], "maxLevel": 153, "bitDepths": [8, 10]] as [String: Any]
        }
        if caps.hardwareAV1 {
            video["av1"] = ["profiles": ["main"], "bitDepths": [8, 10]] as [String: Any]
        }
        profile["video"] = video

        var hdr: [String] = []
        if caps.hdr10 { hdr.append("hdr10") }
        if caps.hlg { hdr.append("hlg") }
        if caps.dolbyVision { hdr.append("dv:5,8") }
        profile["hdr"] = hdr

        if caps.maxHeight >= 2160 {
            profile["maxHeight"] = 2160
            profile["maxWidth"] = 3840
        } else {
            profile["maxHeight"] = 1080
        }

        // AVPlayer decodes AAC, MP3, ALAC, FLAC, AC-3 and E-AC-3 (it downmixes when the screen has no surround),
        // so these channel counts are what the decoder handles, not what the speakers are.
        var eac3: [String: Any] = ["maxChannels": 8]
        if caps.spatialAudio { eac3["atmos"] = true }
        let audio: [String: Any] = [
            "aac": ["maxChannels": 6] as [String: Any],
            "ac3": ["maxChannels": 6] as [String: Any],
            "eac3": eac3,
            "mp3": ["maxChannels": 2] as [String: Any],
            "alac": ["maxChannels": 2] as [String: Any],
            "flac": ["maxChannels": 2] as [String: Any],
        ]
        profile["audio"] = audio
        profile["maxAudioChannels"] = 8

        profile["containers"] = ["mp4", "mov"]
        profile["streaming"] = ["hls-fmp4", "hls-ts"]
        // The app draws WebVTT itself; picture subtitles are burnt in by the server when chosen.
        profile["subtitles"] = ["vtt"]
        return profile
    }

    /// A short line for diagnostics: "hevc h264 · hdr10 hlg dv:5,8 · 2160p".
    public static func summary(_ profile: [String: Any]) -> String {
        let video = (profile["video"] as? [String: Any]).map { Array($0.keys).sorted().joined(separator: " ") } ?? "default"
        let hdr = (profile["hdr"] as? [String]).map { $0.isEmpty ? "SDR" : $0.joined(separator: " ") } ?? "default"
        let height = (profile["maxHeight"] as? Int).map { "\($0)p" } ?? ""
        return [video, hdr, height].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
