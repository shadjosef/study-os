import Foundation
import PDFKit
import AppKit

// Usage:
//   render_pdf <pdf_path> <out_dir> <prefix> [--dpi 180] [--pages 1,2,3] [--crop page:topFrac:bottomFrac:outName]
// Coordinates in --crop: topFrac and bottomFrac are 0.0..1.0 measured from TOP of page!

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 3 else {
    fputs("Usage: render_pdf <pdf_path> <out_dir> <prefix> [--scale 2.0] [--pages 1,2] [--crop page:topFrac:bottomFrac:name]\n", stderr)
    exit(1)
}

let pdfPath = args[0]
let outDir = args[1]
let prefix = args[2]

var scale: CGFloat = 2.0
var selectedPages: Set<Int>? = nil
struct CropSpec {
    let page: Int
    let topFrac: CGFloat
    let bottomFrac: CGFloat
    let name: String
}
var crops: [CropSpec] = []

var i = 3
while i < args.count {
    let flag = args[i]
    if flag == "--scale", i + 1 < args.count {
        scale = CGFloat(Double(args[i + 1]) ?? 2.0)
        i += 2
    } else if flag == "--pages", i + 1 < args.count {
        let nums = args[i + 1].split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        selectedPages = Set(nums)
        i += 2
    } else if flag == "--crop", i + 1 < args.count {
        let parts = args[i + 1].split(separator: ":", maxSplits: 3).map(String.init)
        if parts.count == 4, let p = Int(parts[0]), let t = Double(parts[1]), let b = Double(parts[2]) {
            crops.append(CropSpec(page: p, topFrac: CGFloat(t), bottomFrac: CGFloat(b), name: parts[3]))
        }
        i += 2
    } else {
        i += 1
    }
}

let url = URL(fileURLWithPath: pdfPath)
guard let doc = PDFDocument(url: url) else {
    fputs("Error: Could not open PDF at \(pdfPath)\n", stderr)
    exit(2)
}

try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func renderRegion(page: PDFPage, cropTopFrac: CGFloat, cropBottomFrac: CGFloat, scale: CGFloat, outPath: String) throws {
    let bounds = page.bounds(for: .mediaBox)
    let t = max(0.0, min(1.0, cropTopFrac))
    let b = max(t + 0.01, min(1.0, cropBottomFrac))
    // PDF coordinates have origin at bottom-left:
    let yBottom = bounds.minY + bounds.height * (1.0 - b)
    let yTop = bounds.minY + bounds.height * (1.0 - t)
    let regionHeight = yTop - yBottom
    let pixelW = max(1, Int(ceil(bounds.width * scale)))
    let pixelH = max(1, Int(ceil(regionHeight * scale)))

    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixelW,
        pixelsHigh: pixelH,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .calibratedRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw NSError(domain: "render_pdf", code: 3)
    }

    NSGraphicsContext.saveGraphicsState()
    guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
        NSGraphicsContext.restoreGraphicsState()
        throw NSError(domain: "render_pdf", code: 4)
    }
    NSGraphicsContext.current = ctx
    let cg = ctx.cgContext
    cg.setFillColor(NSColor.white.cgColor)
    cg.fill(CGRect(x: 0, y: 0, width: CGFloat(pixelW), height: CGFloat(pixelH)))
    cg.scaleBy(x: scale, y: scale)
    cg.translateBy(x: -bounds.minX, y: -yBottom)
    page.draw(with: .mediaBox, to: cg)
    NSGraphicsContext.restoreGraphicsState()

    guard let pngData = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "render_pdf", code: 5)
    }
    try pngData.write(to: URL(fileURLWithPath: outPath))
}

if !crops.isEmpty {
    for c in crops {
        guard c.page >= 1 && c.page <= doc.pageCount, let page = doc.page(at: c.page - 1) else { continue }
        let outPath = (outDir as NSString).appendingPathComponent(c.name)
        try renderRegion(page: page, cropTopFrac: c.topFrac, cropBottomFrac: c.bottomFrac, scale: scale, outPath: outPath)
        print(outPath)
    }
} else {
    for idx in 0..<doc.pageCount {
        let pNum = idx + 1
        if let sel = selectedPages, !sel.contains(pNum) { continue }
        guard let page = doc.page(at: idx) else { continue }
        let name = String(format: "%@-p%03d.png", prefix, pNum)
        let outPath = (outDir as NSString).appendingPathComponent(name)
        try renderRegion(page: page, cropTopFrac: 0.0, cropBottomFrac: 1.0, scale: scale, outPath: outPath)
        print(outPath)
    }
}
