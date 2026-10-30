// App locks: the data shared by the app and its three helpers (re-locker, lock screen, lock screen
// button), kept in the App Group so each of them can read it.
//
// Goalie decides when a lock unlocks (all of its goals done) and tells this side through the
// GoalieLocks plugin. The re-locker (GoalieMonitor) locks again when a goal's period restarts, even
// while Goalie is closed. Apple only gives out coded tokens for the chosen apps, never their names.

import Foundation
import FamilyControls
import ManagedSettings

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
