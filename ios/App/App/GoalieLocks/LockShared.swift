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

    /// The goal's limit-lock that covers an app, for the lock screen.
    static func limitGoal(covering app: ApplicationToken?, category: ActivityCategoryToken?, web: WebDomainToken?) -> ScreenGoal? {
        goals().first { goal in
            guard goal.lock, goal.limit > 0, minutesToday(goal.key) >= goal.limit, let picked = selection(goal.key) else { return false }
            if let app, picked.applicationTokens.contains(app) { return true }
            if let web, picked.webDomainTokens.contains(web) { return true }
            if let category, picked.categoryTokens.contains(category) { return true }
            return false
        }
    }
}
