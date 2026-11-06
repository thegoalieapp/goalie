// The summary Goalie leaves for its widgets (syncWidgets in app.js, saved by GoalieWidgetsPlugin in
// the shared App Group), and the timeline that redraws them when a goal's period restarts.

import Foundation
import SwiftUI
import WidgetKit

struct WSnapshot: Codable {
    var name: String?
    var goals: [WGoal]
    var streaks: [WStreak]
    var todoSections: [WTodoSection]?
    var todoPriority: [WTodoQuadrant]?
    var calendar: WCalendar?

    static let group = "group.com.thegoalieapp.goalie"

    static func load() -> WSnapshot? {
        guard let json = UserDefaults(suiteName: group)?.string(forKey: "widgetSnapshot"),
              let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(WSnapshot.self, from: data)
    }

    /// The goals as they stand at this time: any whose period has restarted since Goalie last
    /// wrote this go back to zero.
    func goals(at date: Date) -> [WGoal] { goals.map { $0.at(date) } }

    /// The times the widgets should redraw by themselves: the next restarts, and midnight.
    func redraws(after date: Date) -> [Date] {
        let midnight = Calendar.current.startOfDay(for: date.addingTimeInterval(86_400))
        let limit = date.addingTimeInterval(2 * 86_400)
        let restarts = goals.compactMap { $0.resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
            .filter { $0 > date && $0 < limit }
        return Array(Set(restarts + [midnight])).sorted().prefix(20).map { $0 }
    }

    /// For the widget gallery, before Goalie has written anything.
    static let sample = WSnapshot(
        name: nil,
        goals: [
            WGoal(id: "1", name: "Morning run", color: "#fb923c", ink: "#1c2a4a", kind: "up", count: 20, target: 30, countText: "20/30 min", zeroText: "0/30 min", done: false, doneAtZero: false, period: "TODAY", resetsAt: nil),
            WGoal(id: "2", name: "Read a chapter", color: "#60a5fa", ink: "#1c2a4a", kind: "check", count: 1, target: 0, countText: "Done", zeroText: "Not yet", done: true, doneAtZero: false, period: "TODAY", resetsAt: nil),
            WGoal(id: "3", name: "Drink water", color: "#34d399", ink: "#1c2a4a", kind: "up", count: 5, target: 8, countText: "5/8", zeroText: "0/8", done: false, doneAtZero: false, period: "TODAY", resetsAt: nil),
            WGoal(id: "4", name: "Sweets", color: "#f472b6", ink: "#1c2a4a", kind: "down", count: 1, target: 2, countText: "1/2", zeroText: "0/2", done: true, doneAtZero: true, period: "TODAY", resetsAt: nil),
        ],
        streaks: [
            WStreak(id: "2", name: "Read a chapter", color: "#60a5fa", ink: "#1c2a4a", n: 12, text: "12 days in a row"),
            WStreak(id: "1", name: "Morning run", color: "#fb923c", ink: "#1c2a4a", n: 5, text: "5 days in a row"),
        ],
        todoSections: [
            WTodoSection(name: "Errands", color: nil, ink: nil, items: [
                WTodo(id: "a", title: "Call the dentist", section: "Errands", quadrant: 1),
                WTodo(id: "b", title: "Buy running shoes", section: "Errands", quadrant: nil)]),
            WTodoSection(name: "Home", color: nil, ink: nil, items: [WTodo(id: "c", title: "Water the plants", section: "Home", quadrant: 2)]),
        ],
        todoPriority: [
            WTodoQuadrant(quadrant: 1, items: [WTodo(id: "a", title: "Call the dentist", section: "Errands", quadrant: 1)]),
            WTodoQuadrant(quadrant: 2, items: [WTodo(id: "c", title: "Water the plants", section: "Home", quadrant: 2)]),
            WTodoQuadrant(quadrant: 3, items: []), WTodoQuadrant(quadrant: 4, items: []),
        ],
        calendar: nil)
}

struct WGoal: Codable, Identifiable {
    var id: String
    var name: String
    var color: String
    var ink: String
    var kind: String        // up, down (a limit) or check
    var count: Double
    var target: Double
    var countText: String
    var zeroText: String
    var done: Bool
    var doneAtZero: Bool
    var period: String      // TODAY, THIS WEEK…
    var resetsAt: Double?   // milliseconds, like JavaScript; none: never restarts

    func at(_ date: Date) -> WGoal {
        guard let resetsAt, date.timeIntervalSince1970 * 1000 >= resetsAt else { return self }
        var fresh = self
        fresh.count = 0
        fresh.countText = zeroText
        fresh.done = doneAtZero
        fresh.resetsAt = nil
        return fresh
    }

    /// How full its ring or bar is: progress toward a goal, or how much of a limit is used.
    var fraction: Double {
        if kind == "check" { return done ? 1 : 0 }
        guard target > 0 else { return 0 }
        return min(1, max(0, count / target))
    }

    var link: URL { URL(string: "goalie://goal/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")! }
}

struct WStreak: Codable, Identifiable {
    var id: String
    var name: String
    var color: String
    var ink: String
    var n: Int
    var text: String
}

struct WTodo: Codable, Identifiable {
    var id: String
    var title: String
    var section: String?
    var quadrant: Int?      // 1–4 on the priority list (Q1 high … Q4 none), or none
}

/// A section of the to-do page (none: to-dos with no section), with its own colors if it has them.
struct WTodoSection: Codable {
    var name: String?
    var color: String?
    var ink: String?
    var items: [WTodo]
}

/// One of the priority list's four groups.
struct WTodoQuadrant: Codable {
    var quadrant: Int
    var items: [WTodo]
}

struct WCalendar: Codable {
    var label: String
    var year: Int
    var month: Int
    var weekStart: Int
    var days: [WDay]
}

struct WDay: Codable {
    var day: Int
    var color: String?   // "#22c55e"…, "gold" (over 100%), or none (nothing to score)
}

struct GoalieEntry: TimelineEntry {
    let date: Date
    let snapshot: WSnapshot?
    var goalID: String? = nil
}

/// Every widget but "One goal" (which is chosen by the person, see GoalWidget).
struct GoalieProvider: TimelineProvider {
    func placeholder(in context: Context) -> GoalieEntry { GoalieEntry(date: Date(), snapshot: .sample) }

    func getSnapshot(in context: Context, completion: @escaping (GoalieEntry) -> Void) {
        completion(GoalieEntry(date: Date(), snapshot: WSnapshot.load() ?? (context.isPreview ? .sample : nil)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GoalieEntry>) -> Void) {
        let now = Date(), snapshot = WSnapshot.load()
        let times = [now] + (snapshot?.redraws(after: now) ?? [Calendar.current.startOfDay(for: now.addingTimeInterval(86_400))])
        completion(Timeline(entries: times.map { GoalieEntry(date: $0, snapshot: snapshot) }, policy: .atEnd))
    }
}

extension Color {
    /// "#1c2a4a"
    init(hex: String) {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var value: UInt64 = 0
        Scanner(string: digits).scanHexInt64(&value)
        self.init(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }

    static let goalieNavy = Color(hex: "#1c2a4a")

    /// How light a "#rrggbb" color is, 0 (black) to 1 (white).
    static func lightness(_ hex: String) -> Double {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var value: UInt64 = 0
        Scanner(string: digits).scanHexInt64(&value)
        let r = Double((value >> 16) & 0xff) / 255, g = Double((value >> 8) & 0xff) / 255, b = Double(value & 0xff) / 255
        return 0.299 * r + 0.587 * g + 0.114 * b
    }

    /// A goal's color for rings, bars and dots: white-ish and black-ish goals would vanish on a white
    /// or dark widget, so those use the text color (dark on light widgets, white on dark ones).
    static func shown(_ hex: String) -> Color {
        let light = lightness(hex)
        return light > 0.85 || light < 0.12 ? .primary : Color(hex: hex)
    }
    static func needsOutline(_ hex: String) -> Bool {
        let light = lightness(hex)
        return light > 0.85 || light < 0.12
    }
}
