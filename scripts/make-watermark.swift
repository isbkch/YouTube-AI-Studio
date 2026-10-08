// Regenerate the checked-in overlay: swift scripts/make-watermark.swift
import AppKit

let size = NSSize(width: 480, height: 64)
let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.black.withAlphaComponent(0.55).setFill()
NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 12, yRadius: 12).fill()
let text = "Created by YT AI Studio" as NSString
let attributes: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 30, weight: .semibold),
  .foregroundColor: NSColor.white.withAlphaComponent(0.94),
]
let bounds = text.size(withAttributes: attributes)
text.draw(
  at: NSPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2),
  withAttributes: attributes)
NSGraphicsContext.restoreGraphicsState()
let output = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .deletingLastPathComponent().appendingPathComponent("packages/media/assets/free-watermark.png")
try FileManager.default.createDirectory(
  at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
try bitmap.representation(using: .png, properties: [:])!.write(to: output)
