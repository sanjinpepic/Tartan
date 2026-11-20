import SwiftUI

/// An SVG path's data ("M272.91 422.84c-18.95-17.19…") as a SwiftUI Path: the commands the
/// muscle map uses (M L H V C S Q T A Z, absolute and relative), arcs as curves.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var t = Tokens(Array(d.utf8))
        var cur = CGPoint.zero, start = CGPoint.zero, lastCtrl: CGPoint?, lastQuad: CGPoint?
        var cmd: UInt8 = 0
        while true {
            t.skip()
            guard let c = t.peek() else { break }
            if Tokens.isCommand(c) { cmd = c; t.i += 1 } else if cmd == 0 { break }
            let rel = cmd >= 97
            let base = rel ? cur : .zero
            switch cmd | 0x20 {
            case UInt8(ascii: "m"):
                guard let x = t.num(), let y = t.num() else { return path }
                cur = CGPoint(x: base.x + x, y: base.y + y); start = cur
                path.move(to: cur)
                cmd = rel ? UInt8(ascii: "l") : UInt8(ascii: "L")
                lastCtrl = nil; lastQuad = nil
            case UInt8(ascii: "l"):
                guard let x = t.num(), let y = t.num() else { return path }
                cur = CGPoint(x: base.x + x, y: base.y + y); path.addLine(to: cur)
                lastCtrl = nil; lastQuad = nil
            case UInt8(ascii: "h"):
                guard let x = t.num() else { return path }
                cur = CGPoint(x: (rel ? cur.x : 0) + x, y: cur.y); path.addLine(to: cur)
                lastCtrl = nil; lastQuad = nil
            case UInt8(ascii: "v"):
                guard let y = t.num() else { return path }
                cur = CGPoint(x: cur.x, y: (rel ? cur.y : 0) + y); path.addLine(to: cur)
                lastCtrl = nil; lastQuad = nil
            case UInt8(ascii: "c"):
                guard let x1 = t.num(), let y1 = t.num(), let x2 = t.num(), let y2 = t.num(), let x = t.num(), let y = t.num() else { return path }
                let c1 = CGPoint(x: base.x + x1, y: base.y + y1), c2 = CGPoint(x: base.x + x2, y: base.y + y2)
                cur = CGPoint(x: base.x + x, y: base.y + y)
                path.addCurve(to: cur, control1: c1, control2: c2)
                lastCtrl = c2; lastQuad = nil
            case UInt8(ascii: "s"):
                guard let x2 = t.num(), let y2 = t.num(), let x = t.num(), let y = t.num() else { return path }
                let c1 = lastCtrl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let c2 = CGPoint(x: base.x + x2, y: base.y + y2)
                cur = CGPoint(x: base.x + x, y: base.y + y)
                path.addCurve(to: cur, control1: c1, control2: c2)
                lastCtrl = c2; lastQuad = nil
            case UInt8(ascii: "q"):
                guard let x1 = t.num(), let y1 = t.num(), let x = t.num(), let y = t.num() else { return path }
                let c = CGPoint(x: base.x + x1, y: base.y + y1)
                cur = CGPoint(x: base.x + x, y: base.y + y)
                path.addQuadCurve(to: cur, control: c)
                lastQuad = c; lastCtrl = nil
            case UInt8(ascii: "t"):
                guard let x = t.num(), let y = t.num() else { return path }
                let c = lastQuad.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                cur = CGPoint(x: base.x + x, y: base.y + y)
                path.addQuadCurve(to: cur, control: c)
                lastQuad = c; lastCtrl = nil
            case UInt8(ascii: "a"):
                guard let rx = t.num(), let ry = t.num(), let rot = t.num(), let large = t.flag(), let sweep = t.flag(), let x = t.num(), let y = t.num() else { return path }
                let end = CGPoint(x: base.x + x, y: base.y + y)
                arc(&path, from: cur, to: end, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                cur = end
                lastCtrl = nil; lastQuad = nil
            case UInt8(ascii: "z"):
                path.closeSubpath()
                cur = start
                lastCtrl = nil; lastQuad = nil
            default:
                return path
            }
        }
        return path
    }

    /// An elliptical arc (SVG's endpoint form) as cubic curves.
    private static func arc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rx0: Double, ry ry0: Double, rotation: Double, large: Bool, sweep: Bool) {
        var rx = abs(rx0), ry = abs(ry0)
        if rx == 0 || ry == 0 || p0 == p1 { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180, cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosP * dx + sinP * dy, y1 = -sinP * dx + cosP * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var k = sqrt(max(0, num / den))
        if large == sweep { k = -k }
        let cx1 = k * rx * y1 / ry, cy1 = -k * ry * x1 / rx
        let cx = cosP * cx1 - sinP * cy1 + (p0.x + p1.x) / 2
        let cy = sinP * cx1 + cosP * cy1 + (p0.y + p1.y) / 2
        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
            let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            return a
        }
        let t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && dt > 0 { dt -= 2 * .pi } else if sweep && dt < 0 { dt += 2 * .pi }
        let n = max(1, Int(ceil(abs(dt) / (.pi / 2))))
        let step = dt / Double(n)
        let alpha = 4.0 / 3.0 * tan(step / 4)
        func point(_ t: Double) -> (CGPoint, CGPoint) {
            let ct = cos(t), st = sin(t)
            let p = CGPoint(x: cx + rx * ct * cosP - ry * st * sinP, y: cy + rx * ct * sinP + ry * st * cosP)
            let d = CGPoint(x: -rx * st * cosP - ry * ct * sinP, y: -rx * st * sinP + ry * ct * cosP)
            return (p, d)
        }
        var t = t1
        for _ in 0..<n {
            let (a, da) = point(t), (b, db) = point(t + step)
            path.addCurve(to: b, control1: CGPoint(x: a.x + alpha * da.x, y: a.y + alpha * da.y), control2: CGPoint(x: b.x - alpha * db.x, y: b.y - alpha * db.y))
            t += step
        }
    }

    private struct Tokens {
        let s: [UInt8]
        var i = 0
        init(_ s: [UInt8]) { self.s = s }

        static func isCommand(_ c: UInt8) -> Bool {
            switch c {
            case UInt8(ascii: "e"), UInt8(ascii: "E"): return false
            default: return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
            }
        }

        func peek() -> UInt8? { i < s.count ? s[i] : nil }

        mutating func skip() {
            while i < s.count, s[i] == 32 || s[i] == 44 || s[i] == 10 || s[i] == 13 || s[i] == 9 { i += 1 }
        }

        /** An arc's flag: a single 0 or 1, which may run straight into the next number. */
        mutating func flag() -> Bool? {
            skip()
            guard i < s.count, s[i] == 48 || s[i] == 49 else { return nil }
            defer { i += 1 }
            return s[i] == 49
        }

        mutating func num() -> Double? {
            skip()
            let from = i
            if i < s.count, s[i] == 45 || s[i] == 43 { i += 1 }
            var dot = false, digits = false
            while i < s.count {
                let c = s[i]
                if c >= 48 && c <= 57 { digits = true; i += 1 } else if c == 46 && !dot { dot = true; i += 1 } else { break }
            }
            if digits, i < s.count, s[i] == 101 || s[i] == 69 {
                i += 1
                if i < s.count, s[i] == 45 || s[i] == 43 { i += 1 }
                while i < s.count, s[i] >= 48 && s[i] <= 57 { i += 1 }
            }
            guard digits else { i = from; return nil }
            return Double(String(decoding: s[from..<i], as: UTF8.self))
        }
    }
}
