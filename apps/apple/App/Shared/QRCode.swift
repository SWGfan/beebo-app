import SwiftUI
import UIKit
import CoreImage
import CoreImage.CIFilterBuiltins

enum QRCode {
    static func image(for text: String, scale: CGFloat = 10) -> UIImage? {
        guard !text.isEmpty else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) else { return nil }
        let context = CIContext()
        guard let cgImage = context.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

struct QRCodeView: View {
    let text: String
    let size: CGFloat

    var body: some View {
        Group {
            if let image = QRCode.image(for: text) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .padding(Theme.Spacing.sm)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.cornerRadius, style: .continuous))
            } else {
                Color.clear
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("QR code that opens the sign-in page on your phone")
    }
}
