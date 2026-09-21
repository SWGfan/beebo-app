import AVFoundation
import CoreMedia
import UIKit
import VideoToolbox
import BeeboKit

/// Reads what this device can really decode and show, and turns it into the declaration sent to
/// `POST /api/playback/negotiate` (BeeboKit `DeviceProfile`). Every value is a true statement or the claim is left out:
/// a codec is listed only when VideoToolbox says the hardware decodes it, HDR only when `AVPlayer.availableHDRModes` says the
/// connected screen accepts it, Atmos only when the audio route reports spatial audio. TrueHD / DTS are never listed.
///
/// UNVERIFIED on a real Apple TV / iPhone (this project has only ever compiled in CI): the values these calls return on real
/// hardware have not been read by anyone.
enum DeviceCapabilitiesProbe {
    static func capabilities() -> DeviceCapabilities {
        let hevc = VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC)
        var av1 = false
        if #available(iOS 17.0, tvOS 17.0, *) {
            av1 = VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1)
        }
        let modes = AVPlayer.availableHDRModes
        let session = AVAudioSession.sharedInstance()
        var spatial = false
        if #available(iOS 16.0, tvOS 16.0, *) {
            spatial = session.currentRoute.outputs.contains { $0.isSpatialAudioEnabled }
        }
        #if os(tvOS)
        let platform = DeviceCapabilities.Platform.tvOS
        // On Apple TV the main screen is the HDMI output: 3840 x 2160 when the TV takes 4K.
        let height = UIScreen.main.nativeBounds.height >= 2160 ? 2160 : 1080
        #else
        let platform = DeviceCapabilities.Platform.iOS
        // A phone or tablet is not limited by its screen: any device with HEVC hardware decodes 4K.
        let height = hevc ? 2160 : 1080
        #endif
        return DeviceCapabilities(
            platform: platform,
            deviceName: AppConfig.deviceName,
            hardwareHEVC: hevc,
            hardwareAV1: av1,
            hdr10: modes.contains(.hdr10),
            hlg: modes.contains(.hlg),
            dolbyVision: modes.contains(.dolbyVision),
            maxHeight: height,
            outputChannels: max(2, session.maximumOutputNumberOfChannels),
            spatialAudio: spatial
        )
    }

    static func declaration() -> DeviceProfileDeclaration {
        DeviceProfileDeclaration(DeviceProfile.declaration(capabilities()))
    }
}
