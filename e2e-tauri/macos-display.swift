// XCTest coordinates are display points; PNGs contain physical pixels.
import CoreGraphics
import Foundation

let id = CGMainDisplayID()
let bounds = CGDisplayBounds(id)
let result: [String: Any] = [
    "id": id,
    "x": bounds.origin.x, "y": bounds.origin.y,
    "width": bounds.width, "height": bounds.height,
    "pixelWidth": CGDisplayPixelsWide(id), "pixelHeight": CGDisplayPixelsHigh(id)
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
