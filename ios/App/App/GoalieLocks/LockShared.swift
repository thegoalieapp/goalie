// App locks: the data shared by the app and its three helpers (re-locker, lock screen, lock screen
// button), kept in the App Group so each of them can read it.
//
// Goalie decides when a lock unlocks (all of its goals done) and tells this side through the
// GoalieLocks plugin. The re-locker (GoalieMonitor) locks again when a goal's period restarts, even
// while Goalie is closed. Apple only gives out coded tokens for the chosen apps, never their names.

import Foundation
import FamilyControls
import ManagedSettings
import DeviceActivity

enum LockShared {
    static let group = "group.com.thegoalieapp.goalie"
    static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }
}

/// One goal in a lock, as the lock screen shows it ("Workout 15/45 min").
struct LockGoal: Codable {
    var name: String
    var progress: String
    var done: Bool
    var period: String          // day, week, month, year, or never
    var resetProgress: String   // what the progress reads once its period restarts ("0/45 min")
}

struct LockConfig: Codable {
    var id: String
    var name: String
    var locked: Bool
    var relock: [String]        // the periods that re-lock it (day, week, month, year)
    var goals: [LockGoal]
}

enum LockStorage {
    private static let configsKey = "locks"
    private static let weekStartKey = "weekStart"
    private static let relockDayKey = "lastRelockDay"

    static func configs() -> [LockConfig] {
        guard let data = LockShared.defaults.data(forKey: configsKey) else { return [] }
        return (try? JSONDecoder().decode([LockConfig].self, from: data)) ?? []
    }

    static func saveConfigs(_ configs: [LockConfig]) {
        LockShared.defaults.set(try? JSONEncoder().encode(configs), forKey: configsKey)
    }

    /// 0 = Sunday, 1 = Monday (Goalie's "Week starts on" setting).
    static var weekStart: Int {
        get { LockShared.defaults.integer(forKey: weekStartKey) }
        set { LockShared.defaults.set(newValue, forKey: weekStartKey) }
    }

    /// The day the re-locker last ran ("2026-10-29"), so it re-locks at most once a day.
    static var lastRelockDay: String? {
        get { LockShared.defaults.string(forKey: relockDayKey) }
        set { LockShared.defaults.set(newValue, forKey: relockDayKey) }
    }

    static func selection(_ id: String) -> FamilyActivitySelection? {
        guard let data = LockShared.defaults.data(forKey: "selection-\(id)") else { return nil }
        return try? PropertyListDecoder().decode(FamilyActivitySelection.self, from: data)
    }

    static func saveSelection(_ selection: FamilyActivitySelection, for id: String) {
        LockShared.defaults.set(try? PropertyListEncoder().encode(selection), forKey: "selection-\(id)")
    }

    static func removeSelection(for id: String) {
        LockShared.defaults.removeObject(forKey: "selection-\(id)")
    }

    private static func store(_ id: String) -> ManagedSettingsStore {
        ManagedSettingsStore(named: ManagedSettingsStore.Name("lock-\(id)"))
    }

    /// Put the lock screen on the lock's apps, or take it off.
    static func apply(_ lock: LockConfig) {
        let store = store(lock.id)
        guard lock.locked, let picked = selection(lock.id) else {
            store.clearAllSettings()
            return
        }
        store.shield.applications = picked.applicationTokens.isEmpty ? nil : picked.applicationTokens
        store.shield.applicationCategories = picked.categoryTokens.isEmpty ? nil : .specific(picked.categoryTokens)
        store.shield.webDomains = picked.webDomainTokens.isEmpty ? nil : picked.webDomainTokens
        store.shield.webDomainCategories = picked.categoryTokens.isEmpty ? nil : .specific(picked.categoryTokens)
    }

    static func clear(_ id: String) {
        store(id).clearAllSettings()
    }

    /// The locked lock that covers an app (or website), for the lock screen's text.
    static func lock(covering app: ApplicationToken?, category: ActivityCategoryToken?, web: WebDomainToken? = nil) -> LockConfig? {
        configs().first { lock in
            guard lock.locked, let picked = selection(lock.id) else { return false }
            if let app, picked.applicationTokens.contains(app) { return true }
            if let web, picked.webDomainTokens.contains(web) { return true }
            if let category, picked.categoryTokens.contains(category) { return true }
            return false
        }
    }

    /// Today as "2026-10-30" (the phone's own calendar).
    static func dayKey(_ date: Date = Date()) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// New day: lock again every lock whose goals' period just restarted (a new day for daily
    /// goals; the first day of a week, month or year for the others).
    static func relockForNewPeriods(now: Date = Date()) {
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day, .weekday], from: now)
        let today = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        guard lastRelockDay != today else { return }
        lastRelockDay = today

        var starting: Set<String> = ["day"]
        if ((parts.weekday ?? 1) - 1) == weekStart { starting.insert("week") }
        if parts.day == 1 { starting.insert("month") }
        if parts.day == 1 && parts.month == 1 { starting.insert("year") }

        var all = configs()
        for index in all.indices where !Set(all[index].relock).isDisjoint(with: starting) {
            all[index].locked = true
            for goal in all[index].goals.indices where starting.contains(all[index].goals[goal].period) {
                all[index].goals[goal].done = false
                all[index].goals[goal].progress = all[index].goals[goal].resetProgress
            }
            apply(all[index])
        }
        saveConfigs(all)
    }
}

/* ---------- Screen-time goals ----------
   A minutes-per-day goal can be filled in automatically from Screen Time ("Instagram: under 30 min a
   day"). Apple never hands apps usage numbers, but it does tell the re-locker when the chosen apps
   reach set amounts today, so Goalie asks to hear at every step (5, 10, 15… minutes) and logs the
   highest one reached. A limit goal can also lock its apps once the limit is reached, until midnight. */

struct ScreenGoal: Codable {
    var key: String      // the goal's screen-time key (its apps are saved as "selection-screen-<key>")
    var name: String     // the goal's name, for the lock screen
    var limit: Int       // the goal's target in minutes (0: no target)
    var lock: Bool       // lock the apps once the limit is reached
    var from: String?    // locked hours: "22:00" to "07:00" (none: no locked hours)
    var to: String?
    var days: [Int]?     // the days it applies: 0 = Sunday … 6 = Saturday (none: every day)
    var each: Bool?      // daily limit for each app on its own (true) or all of them combined (none / false)

    /// Whether the limit applies on the day of this date.
    func appliesOn(_ date: Date) -> Bool {
        guard let days, !days.isEmpty else { return true }
        return days.contains(Calendar.current.component(.weekday, from: date) - 1)
    }

    /// Minutes after midnight for "22:00".
    private static func minutes(_ hhmm: String?) -> Int? {
        guard let parts = hhmm?.split(separator: ":").compactMap({ Int($0) }), parts.count == 2 else { return nil }
        return parts[0] * 60 + parts[1]
    }
    var window: (start: Int, end: Int)? {
        guard let start = Self.minutes(from), let end = Self.minutes(to), start != end else { return nil }
        return (start, end)
    }
    /// Inside the locked hours right now, on one of its days. Hours that run past midnight (10 PM to
    /// 7 AM) belong to the day they start: Friday's run ends Saturday morning.
    func inWindow(_ date: Date = Date()) -> Bool {
        guard let window else { return false }
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        let now = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        if window.start < window.end { return now >= window.start && now < window.end && appliesOn(date) }
        if now >= window.start { return appliesOn(date) }
        if now < window.end { return appliesOn(date.addingTimeInterval(-86_400)) }
        return false
    }
}

/// The highest step reached on one day, and when.
struct ScreenUsage: Codable {
    var minutes: Int
    var at: Double       // milliseconds since 1970, like JavaScript
}

enum ScreenStorage {
    private static let goalsKey = "screenGoals"
    private static let usageKey = "screenUsage"

    static func activity(_ key: String) -> DeviceActivityName { DeviceActivityName("goalie.screen.\(key)") }
    static func key(of activity: DeviceActivityName) -> String? {
        let prefix = "goalie.screen."
        return activity.rawValue.hasPrefix(prefix) ? String(activity.rawValue.dropFirst(prefix.count)) : nil
    }
    static func selection(_ key: String) -> FamilyActivitySelection? { LockStorage.selection("screen-\(key)") }

    static func goals() -> [ScreenGoal] {
        guard let data = LockShared.defaults.data(forKey: goalsKey) else { return [] }
        return (try? JSONDecoder().decode([ScreenGoal].self, from: data)) ?? []
    }
    static func saveGoals(_ goals: [ScreenGoal]) {
        LockShared.defaults.set(try? JSONEncoder().encode(goals), forKey: goalsKey)
    }

    /// key → day → highest step reached.
    static func usage() -> [String: [String: ScreenUsage]] {
        guard let data = LockShared.defaults.data(forKey: usageKey) else { return [:] }
        return (try? JSONDecoder().decode([String: [String: ScreenUsage]].self, from: data)) ?? [:]
    }

    /// Record a step reached today (keeps the last three weeks).
    static func record(_ key: String, minutes: Int) {
        var all = usage()
        var days = all[key] ?? [:]
        let today = LockStorage.dayKey()
        if minutes > (days[today]?.minutes ?? 0) {
            days[today] = ScreenUsage(minutes: minutes, at: Date().timeIntervalSince1970 * 1000)
        }
        let cutoff = LockStorage.dayKey(Date().addingTimeInterval(-21 * 86_400))
        all[key] = days.filter { $0.key >= cutoff }
        LockShared.defaults.set(try? JSONEncoder().encode(all), forKey: usageKey)
    }

    static func minutesToday(_ key: String) -> Int { usage()[key]?[LockStorage.dayKey()]?.minutes ?? 0 }

    /// The steps to hear about: every 5 minutes to twice the limit (at least an hour past it), with
    /// bigger steps for long limits so there are never more than 48.
    static func steps(limit: Int) -> [Int] {
        let top = min(24 * 60 - 5, limit > 0 ? max(limit * 2, limit + 60) : 240)
        var step = 5
        while top / step > 48 { step += 5 }
        var list = Array(stride(from: step, through: top, by: step))
        if limit > 0 && !list.contains(limit) { list.append(limit) } // always hear the limit itself
        return list.sorted()
    }

    private static func store(_ key: String) -> ManagedSettingsStore {
        ManagedSettingsStore(named: ManagedSettingsStore.Name("screen-\(key)"))
    }

    /// Lock a goal's apps for the rest of the day (its limit was reached).
    static func lockApps(_ key: String) {
        guard let picked = selection(key) else { return }
        let store = store(key)
        store.shield.applications = picked.applicationTokens.isEmpty ? nil : picked.applicationTokens
        store.shield.applicationCategories = picked.categoryTokens.isEmpty ? nil : .specific(picked.categoryTokens)
        store.shield.webDomains = picked.webDomainTokens.isEmpty ? nil : picked.webDomainTokens
    }

    static func unlockApps(_ key: String) { store(key).clearAllSettings() }

    /* Locked hours: their own activity and their own lock, so the daily-minutes lock and the
       locked hours never undo each other. */
    static func windowActivity(_ key: String) -> DeviceActivityName { DeviceActivityName("goalie.window.\(key)") }
    static func key(ofWindow activity: DeviceActivityName) -> String? {
        let prefix = "goalie.window."
        return activity.rawValue.hasPrefix(prefix) ? String(activity.rawValue.dropFirst(prefix.count)) : nil
    }
    private static func windowStore(_ key: String) -> ManagedSettingsStore {
        ManagedSettingsStore(named: ManagedSettingsStore.Name("window-\(key)"))
    }
    static func lockWindow(_ key: String) {
        guard let picked = selection(key) else { return }
        let store = windowStore(key)
        store.shield.applications = picked.applicationTokens.isEmpty ? nil : picked.applicationTokens
        store.shield.applicationCategories = picked.categoryTokens.isEmpty ? nil : .specific(picked.categoryTokens)
        store.shield.webDomains = picked.webDomainTokens.isEmpty ? nil : picked.webDomainTokens
    }
    static func unlockWindow(_ key: String) { windowStore(key).clearAllSettings() }

    /// The limit whose locked hours cover an app right now, for the lock screen.
    static func windowGoal(covering app: ApplicationToken?, category: ActivityCategoryToken?, web: WebDomainToken?) -> ScreenGoal? {
        goals().first { goal in
            guard goal.inWindow(), let picked = selection(goal.key) else { return false }
            if let app, picked.applicationTokens.contains(app) { return true }
            if let web, picked.webDomainTokens.contains(web) { return true }
            if let category, picked.categoryTokens.contains(category) { return true }
            return false
        }
    }

    /// The goal's limit-lock that covers an app, for the lock screen.
    static func limitGoal(covering app: ApplicationToken?, category: ActivityCategoryToken?, web: WebDomainToken?) -> ScreenGoal? {
        goals().first { goal in
            guard goal.lock, goal.limit > 0, goal.appliesOn(Date()) else { return false }
            if goal.each == true { // only the apps that reached their own limit
                let hit = reachedItems(goal.key)
                if let app, hit.apps.contains(app) { return true }
                if let web, hit.webs.contains(web) { return true }
                if let category, hit.categories.contains(category) { return true }
                return false
            }
            guard minutesToday(goal.key) >= goal.limit, let picked = selection(goal.key) else { return false }
            if let app, picked.applicationTokens.contains(app) { return true }
            if let web, picked.webDomainTokens.contains(web) { return true }
            if let category, picked.categoryTokens.contains(category) { return true }
            return false
        }
    }

    /* "Each" limits: every app, category and website gets its own daily limit. Each one has an
       event named "i<n>" (its place in the saved list below); when one reaches the limit, only it
       is locked, until midnight. */
    struct Items: Codable {
        var apps: [ApplicationToken] = []
        var categories: [ActivityCategoryToken] = []
        var webs: [WebDomainToken] = []
    }
    /// The order the "i<n>" events were made in (a selection's sets have no fixed order).
    static func items(_ key: String) -> Items? {
        guard let data = LockShared.defaults.data(forKey: "screenItems-\(key)") else { return nil }
        return try? PropertyListDecoder().decode(Items.self, from: data)
    }
    static func saveItems(_ items: Items, for key: String) {
        LockShared.defaults.set(try? PropertyListEncoder().encode(items), forKey: "screenItems-\(key)")
    }
    /// Which items reached their limit today ("i<n>" numbers).
    static func reachedToday(_ key: String) -> [Int] {
        guard let saved = LockShared.defaults.dictionary(forKey: "screenReached-\(key)"),
              saved["day"] as? String == LockStorage.dayKey() else { return [] }
        return saved["items"] as? [Int] ?? []
    }
    static func markReached(_ key: String, item: Int) {
        let list = Array(Set(reachedToday(key) + [item])).sorted()
        LockShared.defaults.set(["day": LockStorage.dayKey(), "items": list], forKey: "screenReached-\(key)")
    }
    static func clearReached(_ key: String) { LockShared.defaults.removeObject(forKey: "screenReached-\(key)") }
    /// The tokens of today's reached items.
    static func reachedItems(_ key: String) -> (apps: Set<ApplicationToken>, categories: Set<ActivityCategoryToken>, webs: Set<WebDomainToken>) {
        guard let list = items(key) else { return ([], [], []) }
        var apps = Set<ApplicationToken>(), categories = Set<ActivityCategoryToken>(), webs = Set<WebDomainToken>()
        for n in reachedToday(key) {
            if n < list.apps.count { apps.insert(list.apps[n]) }
            else if n < list.apps.count + list.categories.count { categories.insert(list.categories[n - list.apps.count]) }
            else if n < list.apps.count + list.categories.count + list.webs.count { webs.insert(list.webs[n - list.apps.count - list.categories.count]) }
        }
        return (apps, categories, webs)
    }
    /// Lock just the items that reached their own limit today.
    static func lockReached(_ key: String) {
        let hit = reachedItems(key)
        let store = store(key)
        store.shield.applications = hit.apps.isEmpty ? nil : hit.apps
        store.shield.applicationCategories = hit.categories.isEmpty ? nil : .specific(hit.categories)
        store.shield.webDomains = hit.webs.isEmpty ? nil : hit.webs
    }
}
