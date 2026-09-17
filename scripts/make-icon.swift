import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Renders the yt-ai-studio app icon at every iconset size.
// Coordinates live in a 1024x1024 design space (y-up), scaled per size.

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  FileHandle.standardError.write("usage: make-icon.swift <output-iconset-dir>\n".data(using: .utf8)!)
  exit(2)
}
let outputDirectory = URL(fileURLWithPath: arguments[1], isDirectory: true)

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: r, green: g, blue: b, alpha: a)
}

func scaled(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, by k: CGFloat) -> CGRect {
  CGRect(x: x * k, y: y * k, width: w * k, height: h * k)
}

func drawIcon(pixelSize: Int) -> CGImage? {
  let k = CGFloat(pixelSize) / 1024
  guard
    let ctx = CGContext(
      data: nil, width: pixelSize, height: pixelSize, bitsPerComponent: 8, bytesPerRow: 0,
      space: srgb, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { return nil }
  ctx.setAllowsAntialiasing(true)
  ctx.setShouldAntialias(true)
  ctx.interpolationQuality = .high

  // Big Sur app-icon canvas: 824x824 squircle centered on a 1024 canvas.
  let canvas = scaled(100, 100, 824, 824, by: k)
  let squircle = CGPath(
    roundedRect: canvas, cornerWidth: 185 * k, cornerHeight: 185 * k, transform: nil)

  // Drop shadow baked into the asset, per the Apple template.
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -22 * k), blur: 42 * k, color: rgb(0, 0, 0, 0.32))
  ctx.setFillColor(rgb(0.11, 0.115, 0.15))
  ctx.addPath(squircle)
  ctx.fillPath()
  ctx.restoreGState()

  ctx.saveGState()
  ctx.addPath(squircle)
  ctx.clip()
  let background = CGGradient(
    colorsSpace: srgb,
    colors: [rgb(0.208, 0.220, 0.278), rgb(0.063, 0.067, 0.094)] as CFArray,
    locations: [0, 1])!
  ctx.drawLinearGradient(
    background, start: CGPoint(x: 512 * k, y: 924 * k), end: CGPoint(x: 512 * k, y: 100 * k),
    options: [])
  let sheen = CGGradient(
    colorsSpace: srgb, colors: [rgb(1, 1, 1, 0.09), rgb(1, 1, 1, 0)] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(
    sheen, start: CGPoint(x: 512 * k, y: 924 * k), end: CGPoint(x: 512 * k, y: 430 * k),
    options: [])
  ctx.setStrokeColor(rgb(1, 1, 1, 0.12))
  ctx.setLineWidth(6 * k)
  ctx.addPath(squircle)
  ctx.strokePath()
  ctx.restoreGState()

  // Cloud: flat rounded base plus two puffs, one shared vertical gradient.
  let base = CGPath(
    roundedRect: scaled(252, 350, 520, 212, by: k), cornerWidth: 106 * k, cornerHeight: 106 * k,
    transform: nil)
  let leftPuff = CGPath(ellipseIn: scaled(284, 398, 232, 232, by: k), transform: nil)
  let rightPuff = CGPath(ellipseIn: scaled(496, 394, 280, 280, by: k), transform: nil)
  ctx.saveGState()
  ctx.addPath(base)
  ctx.addPath(leftPuff)
  ctx.addPath(rightPuff)
  ctx.clip()
  let accent = CGGradient(
    colorsSpace: srgb,
    colors: [rgb(0.949, 0.522, 0.294), rgb(0.706, 0.259, 0.110)] as CFArray,
    locations: [0, 1])!
  ctx.drawLinearGradient(
    accent, start: CGPoint(x: 512 * k, y: 674 * k), end: CGPoint(x: 512 * k, y: 350 * k),
    options: [])
  ctx.restoreGState()

  // Play glyph; the round-join stroke rounds the corners of the fill.
  let paper = rgb(1.0, 0.965, 0.937)
  let triangle = CGMutablePath()
  triangle.move(to: CGPoint(x: 452 * k, y: 582 * k))
  triangle.addLine(to: CGPoint(x: 638 * k, y: 484 * k))
  triangle.addLine(to: CGPoint(x: 452 * k, y: 386 * k))
  triangle.closeSubpath()
  ctx.setFillColor(paper)
  ctx.setStrokeColor(paper)
  ctx.setLineWidth(40 * k)
  ctx.setLineJoin(.round)
  ctx.addPath(triangle)
  ctx.drawPath(using: .fillStroke)

  return ctx.makeImage()
}

let sizes: [(pixels: Int, name: String)] = [
  (16, "icon_16x16.png"),
  (32, "icon_16x16@2x.png"),
  (32, "icon_32x32.png"),
  (64, "icon_32x32@2x.png"),
  (128, "icon_128x128.png"),
  (256, "icon_128x128@2x.png"),
  (256, "icon_256x256.png"),
  (512, "icon_256x256@2x.png"),
  (512, "icon_512x512.png"),
  (1024, "icon_512x512@2x.png"),
]

try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
for size in sizes {
  guard let image = drawIcon(pixelSize: size.pixels) else {
    FileHandle.standardError.write("failed to render \(size.name)\n".data(using: .utf8)!)
    exit(1)
  }
  let url = outputDirectory.appendingPathComponent(size.name)
  guard let destination = CGImageDestinationCreateWithURL(
    url as CFURL, UTType.png.identifier as CFString, 1, nil)
  else {
    FileHandle.standardError.write("failed to create \(url.path)\n".data(using: .utf8)!)
    exit(1)
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    FileHandle.standardError.write("failed to write \(url.path)\n".data(using: .utf8)!)
    exit(1)
  }
}
