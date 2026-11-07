import Cocoa

let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor(calibratedRed: 0.961, green: 0.957, blue: 0.929, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 210, yRadius: 210).fill()
let ink = NSColor(calibratedRed: 0.106, green: 0.212, blue: 0.365, alpha: 1)
ink.setStroke()
let page = NSBezierPath(roundedRect: NSRect(x: 230, y: 180, width: 564, height: 664), xRadius: 64, yRadius: 64)
page.lineWidth = 24
page.stroke()
let spine = NSBezierPath()
spine.move(to: NSPoint(x: 325, y: 180))
spine.line(to: NSPoint(x: 325, y: 844))
spine.lineWidth = 16
spine.stroke()
for (x, height) in [(430.0, 130.0), (555.0, 300.0), (680.0, 220.0)] {
    let line = NSBezierPath()
    line.move(to: NSPoint(x: x, y: 360))
    line.line(to: NSPoint(x: x, y: 360 + height))
    line.lineWidth = 34
    line.lineCapStyle = .round
    line.stroke()
}
image.unlockFocus()
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]), CommandLine.arguments.count == 2 else {
    fatalError("Usage: Icon.swift output.png")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
