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
                if Color.needsOutline(goal.color) { Circle().stroke(Color.primary, lineWidth: 1.5) }
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
                    ProgressBar(fraction: goal.fraction, color: goal.kind == "down" && goal.count > goal.target ? .red : Color.shown(goal.color))
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
        let room = family == .systemMedium ? 3 : family == .systemLarge ? 10 : 16
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
                    Ring(fraction: goal.fraction, color: Color.shown(goal.color), width: 10)
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
            .overlay(Circle().stroke(Color.primary, lineWidth: Color.needsOutline(streak.color) ? 1.5 : 0))
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
        // "gold": the day went over 100% (Average progress), shown golden.
        let fill = day.color == "gold" ? Color(hex: "#d4a017") : day.color.map { Color(hex: $0) } ?? Color.secondary.opacity(0.15)
        let lightText = day.color == nil || day.color == "#facc15"
        return Text("\(day.day)")
            .font(.system(size: large ? 12 : 8, weight: .bold, design: .rounded))
            .foregroundColor(lightText ? .primary : .white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: large ? 6 : 3).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: large ? 6 : 3).stroke(Color.primary, lineWidth: today ? 1.5 : 0))
    }
}

// MARK: - To-do list

/// Which list the to-do widget shows: every section, one section, or the priority list.
struct TodoListEntity: AppEntity {
    let id: String          // "all", "prio", "none" (no section) or "sec:<name>"
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "List"
    static var defaultQuery = TodoListQuery()
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

    static let all = TodoListEntity(id: "all", name: "All lists")
    static let priority = TodoListEntity(id: "prio", name: "Priority list")
}

struct TodoListQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [TodoListEntity] { Self.choices().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [TodoListEntity] { Self.choices() }
    func defaultResult() async -> TodoListEntity? { .all }

    static func choices() -> [TodoListEntity] {
        let sections = (WSnapshot.load()?.todoSections ?? []).map { sec in
            sec.name.map { TodoListEntity(id: "sec:\($0)", name: $0) } ?? TodoListEntity(id: "none", name: "No section")
        }
        return [.all] + sections + [.priority]
    }
}

struct PickTodoListIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Choose a list"
    static var description = IntentDescription("Show your to-dos, one section, or the priority list.")

    @Parameter(title: "List")
    var list: TodoListEntity?
}

struct TodoEntry: TimelineEntry {
    let date: Date
    let snapshot: WSnapshot?
    let list: String
}

struct TodoProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TodoEntry { TodoEntry(date: Date(), snapshot: .sample, list: "all") }

    func snapshot(for configuration: PickTodoListIntent, in context: Context) async -> TodoEntry {
        TodoEntry(date: Date(), snapshot: WSnapshot.load() ?? .sample, list: configuration.list?.id ?? "all")
    }

    func timeline(for configuration: PickTodoListIntent, in context: Context) async -> Timeline<TodoEntry> {
        // To-dos only change in Goalie, which redraws the widget when they do.
        Timeline(entries: [TodoEntry(date: Date(), snapshot: WSnapshot.load(), list: configuration.list?.id ?? "all")], policy: .never)
    }
}

struct TodoWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "GoalieTodo", intent: PickTodoListIntent.self, provider: TodoProvider()) { entry in
            TodoView(entry: entry).goalieBackground()
        }
        .configurationDisplayName("To-do list")
        .description("Your to-dos, one section, or the priority list. Press and hold the widget to choose.")
        .supportedFamilies([.systemMedium, .systemLarge, .systemExtraLarge])
    }
}

/// The priority list's four groups, as the to-do page shows them.
private enum Quadrant {
    static let tag = [1: "Q1 · HIGH", 2: "Q2 · MEDIUM", 3: "Q3 · LOW", 4: "Q4 · NONE"]
    static let title = [1: "HIGH PRIORITY", 2: "MEDIUM PRIORITY", 3: "LOW PRIORITY", 4: "NO PRIORITY"]
    static let about = [1: "Q1 · Important & urgent", 2: "Q2 · Important, not urgent", 3: "Q3 · Urgent, not important", 4: "Q4 · Not urgent, not important"]
    static let bar = [1: "#e5484d", 2: "#f0a020", 3: "#4aa8e2", 4: "#9aa0a8"]
    /// (background, text) for the tag, light and dark.
    static func colors(_ q: Int, dark: Bool) -> (String, String) {
        switch (q, dark) {
        case (1, false): return ("#fde1e2", "#b4232a")
        case (2, false): return ("#fdeccc", "#9a5b00")
        case (3, false): return ("#dcedfb", "#1d5f99")
        case (1, true): return ("#4a1d21", "#ffb3b6")
        case (2, true): return ("#4a3510", "#ffd38a")
        case (3, true): return ("#14304a", "#a9d6f5")
        default: return dark ? ("#1f2838", "#9aa0a8") : ("#e8e8e9", "#6b7280")
        }
    }
}

private struct TodoTag: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    let quadrant: Int?

    var body: some View {
        let (back, ink) = quadrant.map { Quadrant.colors($0, dark: scheme == .dark) } ?? Quadrant.colors(4, dark: scheme == .dark)
        Text(text)
            .font(.system(size: 9, weight: .heavy, design: .rounded))
            .tracking(0.4)
            .foregroundColor(Color(hex: ink))
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .background(Capsule().fill(Color(hex: back)))
            .lineLimit(1)
    }
}

/// A to-do: its empty check circle, title, and tag (priority on the lists; section on the priority list).
private struct TodoRow: View {
    let todo: WTodo
    var ink: Color? = nil
    var showSection = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                Circle().stroke(ink?.opacity(0.7) ?? Color.secondary, lineWidth: 1.6).frame(width: 16, height: 16)
                Text(todo.title).font(.system(size: 13, weight: .semibold, design: .rounded)).foregroundColor(ink ?? .primary).lineLimit(1)
                Spacer(minLength: 4)
                if showSection, let section = todo.section {
                    TodoTag(text: section.uppercased(), quadrant: nil)
                } else if let q = todo.quadrant, let tag = Quadrant.tag[q] {
                    TodoTag(text: tag, quadrant: q)
                }
            }
            .padding(.vertical, 4.5)
            Rectangle().fill((ink ?? Color.secondary).opacity(0.25)).frame(height: 0.75)
        }
    }
}

private struct TodoView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodoEntry

    /// How many lines fit (a heading counts as one).
    private var room: Int { family == .systemMedium ? 5 : family == .systemLarge ? 13 : 13 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let snapshot = entry.snapshot {
                if entry.list == "prio" { priority(snapshot) } else { lists(snapshot) }
            } else {
                Note(text: "Open Goalie to see your to-dos here.")
            }
            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: entry.list == "prio" ? "goalie://todo/priority" : "goalie://todo"))
    }

    private func heading(_ name: String, count: Int, ink: Color? = nil) -> some View {
        HStack(spacing: 6) {
            Text(name).font(.system(size: 11, weight: .heavy, design: .rounded)).tracking(1).foregroundColor(ink ?? .primary).lineLimit(1)
            Text("\(count)").font(.system(size: 10, weight: .heavy, design: .rounded)).foregroundColor(ink ?? .primary)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Capsule().fill((ink ?? Color.secondary).opacity(0.18)))
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func lists(_ snapshot: WSnapshot) -> some View {
        let all = snapshot.todoSections ?? []
        let sections = entry.list == "all" ? all
            : entry.list == "none" ? all.filter { $0.name == nil }
            : all.filter { $0.name.map { "sec:\($0)" } == entry.list }
        let plan = fit(sections.map { $0.items.count })
        if sections.allSatisfy({ $0.items.isEmpty }) {
            Note(text: sections.isEmpty ? "This list isn’t in Goalie any more. Press and hold to choose another." : "All done!")
        } else {
            ForEach(Array(sections.enumerated()), id: \.offset) { i, sec in
                if plan[i] >= 0 {
                    let ink = sec.color != nil ? Color(hex: sec.ink ?? "#1c2a4a") : nil
                    VStack(alignment: .leading, spacing: 2) {
                        heading(sec.name?.uppercased() ?? "NO SECTION", count: sec.items.count, ink: ink)
                        ForEach(sec.items.prefix(plan[i])) { todo in TodoRow(todo: todo, ink: ink) }
                        if sec.items.count > plan[i] && plan[i] > 0 {
                            Text("+\(sec.items.count - plan[i]) more").font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundColor(ink ?? .secondary)
                        }
                    }
                    .padding(sec.color != nil ? 7 : 0)
                    .background(RoundedRectangle(cornerRadius: 10).fill(sec.color.map { Color(hex: $0) } ?? Color.clear))
                }
            }
        }
    }

    @ViewBuilder
    private func priority(_ snapshot: WSnapshot) -> some View {
        let groups = (snapshot.todoPriority ?? []).filter { !$0.items.isEmpty }
        let plan = fit(groups.map { $0.items.count })
        if groups.isEmpty {
            Note(text: "No prioritized to-dos")
        } else {
            ForEach(Array(groups.enumerated()), id: \.offset) { i, group in
                if plan[i] >= 0 {
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 2).fill(Color(hex: Quadrant.bar[group.quadrant] ?? "#9aa0a8")).frame(width: 3.5)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                heading(Quadrant.title[group.quadrant] ?? "", count: group.items.count)
                                if family != .systemMedium {
                                    Text(Quadrant.about[group.quadrant] ?? "").font(.system(size: 9, weight: .semibold, design: .rounded)).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            ForEach(group.items.prefix(plan[i])) { todo in TodoRow(todo: todo, showSection: true) }
                            if group.items.count > plan[i] && plan[i] > 0 {
                                Text("+\(group.items.count - plan[i]) more").font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    /// How many to-dos of each group fit: each shown group takes a line for its heading; -1 = no room.
    private func fit(_ counts: [Int]) -> [Int] {
        var left = room
        return counts.map { count in
            guard count > 0, left >= 2 else { return -1 }
            left -= 1
            let take = min(count, left)
            left -= take
            return take
        }
    }
}
