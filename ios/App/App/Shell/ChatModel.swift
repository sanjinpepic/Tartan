import Foundation
import Observation
import UIKit

/// One step the coach took to answer ("Checking how ready you are"), running or done.
@MainActor
@Observable
final class ChatStep: Identifiable {
    let id = UUID()
    let label: String
    var done = false
    init(_ label: String, done: Bool = false) { self.label = label; self.done = done }
}

/// A route in the chat (src/coach.ts RouteCard).
struct ChatRoute: Identifiable {
    let id: String
    let name: String
    let km: Double
    let ascent: Int?
    let loop: Bool
    let onWatch: Bool
    /** [lon, lat] points, for its line. */
    let preview: [(Double, Double)]
    let scenery: String?

    static func parse(_ o: J) -> ChatRoute {
        ChatRoute(id: o["id"].text, name: o["name"].text, km: o["km"].num ?? 0, ascent: o["ascent_m"].int, loop: o["loop"].bool, onWatch: o["on_watch"].bool,
                  preview: o["preview"].array.compactMap { p in let a = p.array; return a.count == 2 ? (a[0].num ?? 0, a[1].num ?? 0) : nil },
                  scenery: o["scenery"].str.flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// A message in the chat. The coach's grows as its answer streams in.
@MainActor
@Observable
final class ChatMsg: Identifiable {
    let id = UUID()
    let user: Bool
    var text: String
    var image: UIImage?
    var steps: [ChatStep] = []
    var streaming = false
    var error: String?
    let started = Date()
    /** "Plan updated · see the plan", "2 changes to the plan · review them": where they go. */
    var links: [(label: String, hash: String)] = []
    /** Who answered ("Gemini 3.8 Flash"). */
    var by: String?
    /** Flagged by you (Report reply): the reason. */
    var reported: String?
    var routes: [ChatRoute] = []

    init(user: Bool, text: String = "", image: UIImage? = nil) {
        self.user = user
        self.text = text
        self.image = image
    }
}

struct ChatStatus { let ready: Bool; let model: String; let photos: Bool }
struct Conv: Identifiable { let id: String; let title: String; let updated: String }

/// A photo for the coach: the JPEG to send (base64), a small one to show (a data URL), and its picture.
struct ChatPhoto {
    let data: String
    let thumb: String
    let image: UIImage

    /** As the web makes one (chatImage): a JPEG at most 1280 px, and a 320 px thumbnail. */
    static func make(_ img: UIImage) -> ChatPhoto? {
        func jpeg(_ max: CGFloat, _ q: CGFloat) -> Data? {
            let k = min(1, max / Swift.max(img.size.width, img.size.height))
            let size = CGSize(width: (img.size.width * k).rounded(), height: (img.size.height * k).rounded())
            let r = UIGraphicsImageRenderer(size: size)
            return r.image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }.jpegData(compressionQuality: q)
        }
        guard let full = jpeg(1280, 0.85), let small = jpeg(320, 0.7), let thumb = UIImage(data: small) else { return nil }
        return ChatPhoto(data: full.base64EncodedString(), thumb: "data:image/jpeg;base64," + small.base64EncodedString(), image: thumb)
    }
}

/// The coach's chat (Android's ChatModel): a conversation, its messages, sending one (with a
/// photo) and reading the answer as it streams: the steps the coach takes, its words, whether it
/// changed the plan or suggests changes, the routes it made.
@MainActor
@Observable
final class ChatModel {
    private let engine: EngineBridge
    var status: ChatStatus?
    /** The conversation open; nil: a new one. */
    var conversation: String?
    var messages: [ChatMsg] = []
    var draft = ""
    var photo: ChatPhoto?
    var busy = false
    var loading = false
    var list: [Conv] = []
    /** Bumped when the chat should take the keyboard (opened to ask something). */
    var focusAsk = 0
    @ObservationIgnored private var opened = false
    /** Bumped by every load and send: a load that finishes after a newer one (or a send) is dropped. */
    @ObservationIgnored private var gen = 0

    init(engine: EngineBridge) { self.engine = engine }

    /** Open the chat: a given conversation (nil: a new one; not given: your latest), and words to start with. */
    func open(conversation: String?, given: Bool, prefill: String?) {
        opened = true
        if let prefill { draft = prefill }
        if prefill != nil || given { focusAsk += 1 }
        Task {
            await readStatus()
            // An answer still coming in stays live; only another conversation, asked for by name, replaces it.
            if busy && (!given || conversation == self.conversation) { return }
            if Launch.chatSample { sample(); return }
            let id: String?
            if given { id = conversation } else { id = J(json: await engine.get("/api/coach/conversations") ?? "[]").array.first?["id"].str }
            await load(id)
        }
    }

    /** Shown without being opened from somewhere: the latest conversation, once; after that, as saved. */
    func ensure() {
        if !opened { open(conversation: nil, given: false, prefill: nil); return }
        Task {
            await readStatus()
            if !busy, let c = conversation, !Launch.chatSample { await load(c, quiet: true) }
        }
    }

    private func readStatus() async {
        if Launch.chatSample { status = ChatStatus(ready: true, model: "Gemini", photos: true); return }
        guard let j = await engine.get("/api/coach/status") else { return }
        let s = J(json: j)
        let id = s["model"].text
        let label = s["answers"].str.flatMap { $0.isEmpty ? nil : $0 } ?? s["models"].array.first { $0["id"].text == id }?["label"].str ?? id
        status = ChatStatus(ready: s["ready"].bool, model: label, photos: s.has("photos") ? s["photos"].bool : true)
    }

    /** Show a conversation as saved; quiet: keep what's on screen until it's read. */
    func load(_ id: String?, quiet: Bool = false) async {
        gen += 1
        let mine = gen
        conversation = id
        guard let id else { loading = false; messages = []; return }
        if !quiet { messages = []; loading = true }
        let c = await engine.get("/api/coach/conversations/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)")
        guard mine == gen else { return }
        loading = false
        let display = J(json: c)["display"].array
        guard !display.isEmpty || c != nil else { return }
        let read = display.map { m -> ChatMsg in
            let msg = ChatMsg(user: m["role"].text == "user", text: m["text"].text, image: m["image"].str.flatMap(ChatModel.decode))
            msg.steps = m["tools"].strings.map { ChatStep($0, done: true) }
            msg.by = m["by"].str.flatMap { $0.isEmpty ? nil : $0 }
            msg.reported = m["reported"].str.flatMap { $0.isEmpty ? nil : $0 }
            // A turn that failed: its error, kept with the question (Ask again).
            if m["failed"].bool && !msg.user { msg.error = m["error"].str.flatMap { $0.isEmpty ? nil : $0 } ?? "This answer didn't come through." }
            msg.routes = m["routes"].array.map(ChatRoute.parse)
            if msg.routes.isEmpty, m["route"].object != nil { msg.routes = [ChatRoute.parse(m["route"])] }
            return msg
        }
        if quiet && read.count == messages.count && zip(read, messages).allSatisfy({ $0.text == $1.text }) { return }
        messages = read
    }

    func newChat() { Task { await load(nil) } }

    func readList() {
        Task {
            list = J(json: await engine.get("/api/coach/conversations") ?? "[]").array.map { Conv(id: $0["id"].text, title: $0["title"].text, updated: $0["updated"].text) }
        }
    }

    /** A reply that failed: its question asked again. */
    func retry(_ m: ChatMsg) {
        guard let i = messages.firstIndex(where: { $0 === m }), let q = messages[..<i].last(where: { $0.user })?.text else { return }
        send(q)
    }

    /** Report a reply (kept with the chat); `then` gets the question and reply back, for an issue. */
    func report(_ m: ChatMsg, reason: String, note: String, then: @escaping (_ question: String, _ reply: String, _ by: String?) -> Void) {
        guard let id = conversation, let index = messages.firstIndex(where: { $0 === m }) else { return }
        m.reported = reason
        Task {
            let r = await engine.call("/api/coach/report", method: "POST", body: jsonText(["conversation": id, "index": index, "reason": reason, "note": note]))
            let o = J(json: r.body)
            then(o["question"].text, o["reply"].str ?? m.text, o["by"].str.flatMap { $0.isEmpty ? nil : $0 } ?? m.by)
        }
    }

    func send(_ said: String) {
        var text = said.trimmingCharacters(in: .whitespacesAndNewlines)
        let sending = photo
        if sending != nil && text.isEmpty { text = "What do you make of this?" }
        guard !text.isEmpty, !busy else { return }
        photo = nil
        draft = ""
        messages.append(ChatMsg(user: true, text: text, image: sending?.image))
        let reply = ChatMsg(user: false)
        reply.streaming = true
        messages.append(reply)
        busy = true
        gen += 1
        loading = false
        var body: [String: Any] = ["conversation": conversation.map { $0 as Any } ?? NSNull(), "message": text]
        if let p = sending { body["images"] = [["mime": "image/jpeg", "data": p.data, "thumb": p.thumb]] }
        Task {
            let r = await engine.call("/api/coach/chat", method: "POST", body: jsonText(body)) { [weak self] line in
                self?.take(line, into: reply)
            }
            if !(200..<300).contains(r.status) && reply.error == nil {
                reply.error = r.status == 599 ? "No answer from the coach. Try again in a moment." : "The coach couldn't answer (\(r.status))."
            }
            for s in reply.steps { s.done = true }
            reply.streaming = false
            busy = false
            if !messages.contains(where: { $0 === reply }), let c = conversation { await load(c, quiet: true) }
        }
    }

    /** One line of the answer as it streams (NDJSON). */
    private func take(_ line: String, into reply: ChatMsg) {
        let m = J(json: line)
        switch m["type"].text {
        case "conversation": conversation = m["id"].str
        case "tool":
            reply.steps.last?.done = true
            reply.steps.append(ChatStep(m["label"].text))
        case "text": reply.text += m["delta"].text
        case "by": reply.by = m["label"].str.flatMap { $0.isEmpty ? nil : $0 }
        case "plan":
            let n = m["proposed"].int ?? 0
            reply.links.append(n > 0 ? (label: "\(n) change\(n == 1 ? "" : "s") to the plan · review \(n == 1 ? "it" : "them")", hash: "coach") : (label: "Plan updated · see the plan", hash: "coach"))
        case "route":
            let r = ChatRoute.parse(m)
            if !reply.routes.contains(where: { $0.id == r.id }) { reply.routes.append(r) }
        case "error": reply.error = m["message"].text
        default: break
        }
    }

    /** A data URL (or bare base64) to a picture. */
    static func decode(_ src: String) -> UIImage? {
        let b64 = src.components(separatedBy: "base64,").last ?? src
        return Data(base64Encoded: b64, options: .ignoreUnknownCharacters).flatMap(UIImage.init(data:))
    }

    /** Screenshots (Launch.chatSample): a made-up conversation, drawn without asking anyone. */
    private func sample() {
        conversation = nil
        let q = ChatMsg(user: true, text: "Was my last run too hard?")
        let a = ChatMsg(user: false, text: "A little, yes. Thursday's 9 km averaged **163 bpm**, above your easy ceiling of 121, and most of it sat in zones 4 and 5.\n\n- Your fitness is climbing (76), but fatigue is higher (90), so form is at −27.\n- Keep today's easy run truly easy: under 121 bpm, even if that means walking the hills.\n\nI've made you a flat 8 km loop for it.")
        a.steps = ["Reading your last workout", "Checking how ready you are", "Looking at this week's plan", "Making a route"].map { ChatStep($0, done: true) }
        a.by = "Gemini 3.8 Flash"
        let loop: [(Double, Double)] = (0..<40).map { i in
            let t = Double(i) / 39 * 2 * .pi
            return (24.905 + 0.012 * cos(t) + 0.002 * sin(3 * t), 60.195 + 0.0055 * sin(t))
        }
        a.routes = [ChatRoute(id: "sample", name: "Central Park easy loop", km: 8.1, ascent: 42, loop: true, onWatch: false, preview: loop, scenery: "mostly park paths and woods")]
        a.links = [(label: "1 change to the plan · review it", hash: "coach")]
        messages = [q, a]
        Launch.ready("chat")
    }
}
