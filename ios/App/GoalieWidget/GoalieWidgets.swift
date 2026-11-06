// Goalie's Home Screen and Lock Screen widgets. They only show (tapping one opens Goalie on what it
// shows); Goalie keeps their summary up to date (see GoalieWidgetData.swift).
//   Today's goals    medium, large, extra large (iPad)
//   One goal         small; Lock Screen ring and line (long-press the widget to choose the goal)
//   Today on the Lock Screen   ring, line and one-liner: how many of today's goals are done
//   Streaks          small, medium
//   Calendar         medium, large: this month's daily goals, colored like Stats → Calendar
//   To-do list       medium, large

import SwiftUI
import WidgetKit
import AppIntents

@main
struct GoalieWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        GoalWidget()
        SummaryWidget()
        StreaksWidget()
        CalendarWidget()
        TodoWidget()
    }
}

// MARK: - Pieces

extension View {
    func goalieBackground() -> some View {
        containerBackground(for: .widget) { Color(UIColor.systemBackground) }
    }
}

private struct Header: View {
    let title: String
    var detail: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.system(size: 13, weight: .heavy, design: .rounded))
            Spacer(minLength: 4)
            if let detail {
                Text(detail).font(.system(size: 12, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
            }
        }
    }
}

private struct Note: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 13, weight: .medium, design: .rounded))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
    }
}

private struct ProgressBar: View {
    let fraction: Double
    let color: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(color.opacity(0.22))
                Capsule().fill(color).frame(width: max(5, geo.size.width * fraction))
            }
        }
        .frame(height: 5)
    }
}

private struct Ring: View {
    let fraction: Double
    let color: Color
    var width: CGFloat = 9

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.22), lineWidth: width)
            Circle().trim(from: 0, to: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
    }
}

/// A goal's color dot (a ✓ once it's done), name, count and bar.
private struct GoalRow: View {
    let goal: WGoal

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().fill(Color(hex: goal.color))
                if goal.done {
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .heavy)).foregroundColor(Color(hex: goal.ink))
                }
            }
            .frame(width: 17, height: 17)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text(goal.name).font(.system(size: 13, weight: .semibold, design: .rounded)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(goal.countText).font(.system(size: 12, weight: .bold, design: .rounded)).foregroundStyle(.secondary).lineLimit(1)
                }
                if goal.kind != "check" && goal.target > 0 {
                    ProgressBar(fraction: goal.fraction, color: goal.kind == "down" && goal.count > goal.target ? .red : Color(hex: goal.color))
                }
            }
        }
    }
}

// MARK: - Today's goals

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "GoalieToday", provider: GoalieProvider()) { entry in
            TodayView(entry: entry).goalieBackground()
        }
        .configurationDisplayName("Today’s goals")
        .description("Your goals for today and how far along each one is.")
        .supportedFamilies([.systemMedium, .systemLarge, .systemExtraLarge])
    }
}

private struct TodayView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GoalieEntry

    var body: some View {
        let goals = entry.snapshot?.goals(at: entry.date) ?? []
        let done = goals.filter { $0.done }.count
        let room = family == .systemMedium ? 3 : family == .systemLarge ? 8 : 16
        let shown = Array(goals.prefix(room))
        VStack(alignment: .leading, spacing: 9) {
            Header(title: "TODAY", detail: goals.isEmpty ? nil : "\(done) of \(goals.count) done")
            if entry.snapshot == nil {
                Note(text: "Open Goalie to see your goals here.")
            } else if goals.isEmpty {
                Note(text: "No goals are measured today.")
            } else if family == .systemExtraLarge {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 18), GridItem(.flexible())], alignment: .leading, spacing: 12) {
                    ForEach(shown) { goal in Link(destination: goal.link) { GoalRow(goal: goal) } }
                }
            } else {
                ForEach(shown) { goal in Link(destination: goal.link) { GoalRow(goal: goal) } }
            }
            if goals.count > shown.count {
                Text("+\(goals.count - shown.count) more").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: "goalie://home"))
    }
}

// MARK: - One goal

struct GoalEntity: AppEntity {
    let id: String
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Goal"
    static var defaultQuery = GoalQuery()
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct GoalQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [GoalEntity] { Self.all().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [GoalEntity] { Self.all() }
    func defaultResult() async -> GoalEntity? { Self.all().first }

    static func all() -> [GoalEntity] { (WSnapshot.load()?.goals ?? []).map { GoalEntity(id: $0.id, name: $0.name) } }
}

struct PickGoalIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Choose a goal"
    static var description = IntentDescription("Show one goal’s progress.")

    @Parameter(title: "Goal")
    var goal: GoalEntity?
}

struct GoalProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> GoalieEntry { GoalieEntry(date: Date(), snapshot: .sample, goalID: "1") }

    func snapshot(for configuration: PickGoalIntent, in context: Context) async -> GoalieEntry {
        GoalieEntry(date: Date(), snapshot: WSnapshot.load() ?? .sample, goalID: configuration.goal?.id)
    }

    func timeline(for configuration: PickGoalIntent, in context: Context) async -> Timeline<GoalieEntry> {
        let now = Date(), snapshot = WSnapshot.load()
        let times = [now] + (snapshot?.redraws(after: now) ?? [])
        return Timeline(entries: times.map { GoalieEntry(date: $0, snapshot: snapshot, goalID: configuration.goal?.id) }, policy: .atEnd)
    }
}

struct GoalWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "GoalieGoal", intent: PickGoalIntent.self, provider: GoalProvider()) { entry in
            GoalView(entry: entry).goalieBackground()
        }
        .configurationDisplayName("One goal")
        .description("One goal’s progress. Press and hold the widget to choose the goal.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

private struct GoalView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GoalieEntry

    var body: some View {
        let goals = entry.snapshot?.goals(at: entry.date) ?? []
        if let goal = goals.first(where: { $0.id == entry.goalID }) ?? goals.first {
            content(goal).widgetURL(goal.link)
        } else {
            Note(text: entry.snapshot == nil ? "Open Goalie first" : "No goal")
        }
    }

    /// "67%" (or ✓ for check-offs) for the small Lock Screen ring.
    private func short(_ goal: WGoal) -> String {
        if goal.kind == "check" { return goal.done ? "✓" : "–" }
        return goal.target > 0 ? "\(Int((goal.fraction * 100).rounded()))%" : goal.countText
    }

    @ViewBuilder
    private func content(_ goal: WGoal) -> some View {
        switch family {
        case .accessoryCircular:
            Gauge(value: goal.fraction) {
                Text(goal.name)
            } currentValueLabel: {
                Text(short(goal)).minimumScaleFactor(0.5)
            }
            .gaugeStyle(.accessoryCircularCapacity)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Text(goal.name).font(.headline).lineLimit(1)
                Text(goal.countText).font(.caption).lineLimit(1)
                ProgressView(value: goal.fraction)
            }
        default:
            VStack(spacing: 6) {
                ZStack {
                    Ring(fraction: goal.fraction, color: Color(hex: goal.color), width: 10)
                    if goal.kind == "check" {
                        Image(systemName: goal.done ? "checkmark" : "circle.dashed").font(.system(size: 24, weight: .heavy))
                    } else {
                        Text(goal.countText).font(.system(size: 15, weight: .heavy, design: .rounded)).minimumScaleFactor(0.5).lineLimit(1).padding(.horizontal, 14)
                    }
                }
                Text(goal.name).font(.system(size: 13, weight: .semibold, design: .rounded)).lineLimit(1)
                Text(goal.period).font(.system(size: 10, weight: .bold, design: .rounded)).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Today on the Lock Screen

struct SummaryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "GoalieSummary", provider: GoalieProvider()) { entry in
            SummaryView(entry: entry).goalieBackground()
        }
        .configurationDisplayName("Goals done today")
        .description("How many of today’s goals are done.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct SummaryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GoalieEntry

    var body: some View {
        let goals = entry.snapshot?.goals(at: entry.date) ?? []
        let done = goals.filter { $0.done }.count
        let next = goals.first { !$0.done }
        Group {
            switch family {
            case .accessoryCircular:
                Gauge(value: Double(done), in: 0...Double(max(goals.count, 1))) {
                    Text("Goals")
                } currentValueLabel: {
                    Text("\(done)/\(goals.count)").minimumScaleFactor(0.5)
                }
                .gaugeStyle(.accessoryCircularCapacity)
            case .accessoryInline:
                Label(goals.isEmpty ? "No goals today" : "\(done) of \(goals.count) goals done", systemImage: "checkmark.circle")
            default:
                VStack(alignment: .leading, spacing: 2) {
                    Text("Goalie").font(.headline)
                    Text(goals.isEmpty ? "No goals today" : "\(done) of \(goals.count) goals done").font(.caption)
                    if let next { Text("Next: \(next.name)").font(.caption).lineLimit(1) }
                }
            }
        }
        .widgetURL(URL(string: "goalie://home"))
    }
}

// MARK: - Streaks

struct StreaksWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "GoalieStreaks", provider: GoalieProvider()) { entry in
            StreaksView(entry: entry).goalieBackground()
        }
        .configurationDisplayName("Streaks")
        .description("Your longest streaks going right now.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct StreakBadge: View {
    let streak: WStreak
    var size: CGFloat = 30

    var body: some View {
        Text("\(streak.n)")
            .font(.system(size: size * 0.45, weight: .heavy, design: .rounded))
            .minimumScaleFactor(0.5)
            .foregroundColor(Color(hex: streak.ink))
            .frame(width: size, height: size)
            .background(Circle().fill(Color(hex: streak.color)))
    }
}

private struct StreaksView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GoalieEntry

    var body: some View {
        let streaks = entry.snapshot?.streaks ?? []
        VStack(alignment: .leading, spacing: 8) {
            Header(title: "STREAKS")
            if let top = streaks.first, family == .systemSmall {
                Spacer(minLength: 0)
                StreakBadge(streak: top, size: 46)
                Text(top.name).font(.system(size: 14, weight: .bold, design: .rounded)).lineLimit(1)
                Text(top.text).font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.secondary).lineLimit(2)
            } else if streaks.isEmpty {
                Note(text: entry.snapshot == nil ? "Open Goalie to see your streaks here." : "Complete a goal two periods in a row to start a streak.")
            } else {
                ForEach(streaks.prefix(3)) { streak in
                    HStack(spacing: 8) {
                        StreakBadge(streak: streak, size: 26)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(streak.name).font(.system(size: 13, weight: .semibold, design: .rounded)).lineLimit(1)
                            Text(streak.text).font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: "goalie://streaks"))
    }
}

// MARK: - Calendar

struct CalendarWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "GoalieCalendar", provider: GoalieProvider()) { entry in
            CalendarView(entry: entry).goalieBackground()
        }
        .configurationDisplayName("Calendar")
        .description("This month’s daily goals, colored by how many you completed each day.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct CalendarView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GoalieEntry
    private static let letters = ["S", "M", "T", "W", "T", "F", "S"]

    var body: some View {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: entry.date)
        VStack(alignment: .leading, spacing: family == .systemLarge ? 8 : 3) {
            if let cal = entry.snapshot?.calendar, cal.year == parts.year, cal.month == parts.month {
                Header(title: cal.label.uppercased())
                grid(cal, today: parts.day ?? 0)
            } else {
                Header(title: "CALENDAR")
                Note(text: "Open Goalie to update this month.")
            }
        }
        .widgetURL(URL(string: "goalie://calendar"))
    }

    private func grid(_ cal: WCalendar, today: Int) -> some View {
        let first = DateComponents(calendar: .current, year: cal.year, month: cal.month, day: 1).date ?? entry.date
        let lead = (Calendar.current.component(.weekday, from: first) - 1 - cal.weekStart + 7) % 7
        let cells: [WDay?] = Array(repeating: nil, count: lead) + cal.days.map { Optional($0) }
        let rows = stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<min($0 + 7, cells.count)]) }
        let large = family == .systemLarge
        return VStack(spacing: large ? 5 : 2) {
            HStack(spacing: large ? 5 : 3) {
                ForEach(0..<7, id: \.self) { i in
                    Text(Self.letters[(cal.weekStart + i) % 7]).font(.system(size: large ? 11 : 8, weight: .bold, design: .rounded))
                        .foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
            }
            ForEach(0..<rows.count, id: \.self) { r in
                HStack(spacing: large ? 5 : 3) {
                    ForEach(0..<7, id: \.self) { c in
                        if c < rows[r].count, let day = rows[r][c] {
                            dayCell(day, today: day.day == today, large: large)
                        } else {
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
    }

    private func dayCell(_ day: WDay, today: Bool, large: Bool) -> some View {
        let fill = day.color.map { Color(hex: $0) } ?? Color.secondary.opacity(0.15)
        let lightText = day.color == nil || day.color == "#facc15" || day.color == "#ffffff"
        return Text("\(day.day)")
            .font(.system(size: large ? 12 : 8, weight: .bold, design: .rounded))
            .foregroundColor(lightText ? .primary : .white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: large ? 6 : 3).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: large ? 6 : 3).stroke(Color.primary, lineWidth: today ? 1.5 : 0))
    }
}

// MARK: - To-do list

struct TodoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "GoalieTodo", provider: GoalieProvider()) { entry in
            TodoView(entry: entry).goalieBackground()
        }
        .configurationDisplayName("To-do list")
        .description("What’s left on your to-do list.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct TodoView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GoalieEntry

    var body: some View {
        let todos = entry.snapshot?.todos ?? []
        let room = family == .systemLarge ? 10 : 4
        VStack(alignment: .leading, spacing: 8) {
            Header(title: "TO-DO", detail: entry.snapshot.map { "\($0.todosLeft) left" })
            if entry.snapshot == nil {
                Note(text: "Open Goalie to see your to-dos here.")
            } else if todos.isEmpty {
                Note(text: "All done!")
            } else {
                ForEach(todos.prefix(room)) { todo in
                    HStack(spacing: 8) {
                        Circle().stroke(Color.secondary, lineWidth: 1.5).frame(width: 14, height: 14)
                        Text(todo.title).font(.system(size: 13, weight: .medium, design: .rounded)).lineLimit(1)
                        Spacer(minLength: 4)
                        if todo.priority == true {
                            Image(systemName: "star.fill").font(.system(size: 10)).foregroundColor(.orange)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: "goalie://todo"))
    }
}
