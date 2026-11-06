// App locks: the data shared by the app and its three helpers (re-locker, lock screen, lock screen
// button), kept in the App Group so each of them can read it.
//
// Goalie decides when a lock unlocks (all of its goals done) and tells this side through the
// GoalieLocks plugin. The re-locker (GoalieMonitor) locks again when a goal's period restarts, even
// while Goalie is closed. Apple only gives out coded tokens for the chosen apps, never their names.

import Foundation
import CryptoKit
import FamilyControls
import ManagedSettings
import DeviceActivity

enum LockShared {
    static let group = "group.com.thegoalieapp.goalie"
    static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }
}

/// Putting the lock screen on apps. Every lock and limit adds to one combined list, so an app is
/// locked whenever anything that includes it is locked (two limits with the same app never undo
/// each other). iPhone blocks at most 50 apps (or websites, or categories) per settings store, so
/// the list is spread over "goalie-apps-0", "goalie-apps-1"… (up to 500 of each). iPhone is only
/// told when the list changes: rewriting the blocks every minute made the whole phone lag.
enum Shield {
    private static let perStore = 50
    private static let maxStores = 10
    private static let fingerprintKey = "shieldFingerprintV4"

    private static func store(_ kind: String, _ n: Int) -> ManagedSettingsStore {
        ManagedSettingsStore(named: ManagedSettingsStore.Name("goalie-\(kind)-\(n)"))
    }

    /// Work out everything that should be locked right now and tell iPhone, if it changed.
    static func refresh() {
        clearOldStores()
        clearMixedStores()
        var apps = Set<ApplicationToken>(), categories = Set<ActivityCategoryToken>(), webs = Set<WebDomainToken>()
        func add(_ picked: FamilyActivitySelection) {
            apps.formUnion(picked.applicationTokens)
            categories.formUnion(picked.categoryTokens)
            webs.formUnion(picked.webDomainTokens)
        }
        for lock in LockStorage.configs() where lock.locked {
            if let picked = LockStorage.selection(lock.id) { add(picked) }
        }
        for goal in ScreenStorage.goals() {
            guard let picked = ScreenStorage.selection(goal.key) else { continue }
            if ScreenStorage.windowLocked(goal.key) || ScreenStorage.limitLocked(goal.key) {
                add(picked)
            } else if goal.each == true, goal.lock, goal.appliesOn(Date()) { // just the apps at their own limit
                let hit = ScreenStorage.reachedItems(goal.key)
                apps.formUnion(hit.apps); categories.formUnion(hit.categories); webs.formUnion(hit.webs)
            }
        }

        // The same order in the app and its helpers, so the same list always lands in the same stores.
        let appList = ordered(apps), webList = ordered(webs), categoryList = ordered(categories)
        var codes: [String] = appList.map { $0.code }
        codes.append("|")
        codes += webList.map { $0.code }
        codes.append("|")
        codes += categoryList.map { $0.code }
        let digest = SHA256.hash(data: Data(codes.joined(separator: ",").utf8))
        let fingerprint = digest.map { String(format: "%02x", $0) }.joined()
        let defaults = LockShared.defaults
        // Unchanged, and iPhone still has it (turning Screen Time access off wipes every block).
        let wiped = (!appList.isEmpty && store("apps", 0).shield.applications == nil)
            || (!webList.isEmpty && store("webs", 0).shield.webDomains == nil)
            || (!categoryList.isEmpty && store("cats", 0).shield.applicationCategories == nil)
        guard defaults.string(forKey: fingerprintKey) != fingerprint || wiped else { return }

        // Apps, websites and categories each get their own stores of at most 50, so no store ever
        // holds more than one list's worth (a store over iPhone's limit can be ignored altogether).
        // Only the stores in use now or last time are touched (an app can only have so many).
        var used = defaults.dictionary(forKey: "shieldStoreCounts") as? [String: Int] ?? [:]
        func write<T>(_ kind: String, _ list: [T], _ apply: (ManagedSettingsStore, [T]) -> Void) {
            let needed = min(maxStores, (list.count + perStore - 1) / perStore)
            for n in 0..<max(needed, used[kind] ?? 0) {
                let part = Array(list.dropFirst(n * perStore).prefix(perStore))
                if part.isEmpty { store(kind, n).clearAllSettings() } else { apply(store(kind, n), part) }
            }
            used[kind] = needed
        }
        write("apps", appList.map { $0.token }) { store, part in store.shield.applications = Set(part) }
        write("webs", webList.map { $0.token }) { store, part in store.shield.webDomains = Set(part) }
        write("cats", categoryList.map { $0.token }) { store, part in
            store.shield.applicationCategories = .specific(Set(part))
            store.shield.webDomainCategories = .specific(Set(part))
        }
        defaults.set(used, forKey: "shieldStoreCounts")
        defaults.set(fingerprint, forKey: fingerprintKey)
    }

    /// Screen Time access was turned off and on again (iPhone drops every block): write it all again.
    static func forget() { LockShared.defaults.removeObject(forKey: fingerprintKey) }

    private static func ordered<T: Encodable & Hashable>(_ tokens: Set<T>) -> [(token: T, code: String)] {
        let encoder = JSONEncoder()
        var list: [(token: T, code: String)] = []
        for token in tokens {
            let code = (try? encoder.encode(token))?.base64EncodedString() ?? ""
            list.append((token: token, code: code))
        }
        return list.sorted { $0.code < $1.code }
    }

    /// Builds 15 and 16 kept a separate store for every lock and limit ("lock-x", "screen-x",
    /// "window-x", each with "-1"… "-5"). Clear those once.
    private static func clearOldStores() {
        let defaults = LockShared.defaults
        guard !defaults.bool(forKey: "shieldStoresV3") else { return }
        let bases = LockStorage.configs().map { "lock-\($0.id)" }
            + ScreenStorage.goals().flatMap { ["screen-\($0.key)", "window-\($0.key)"] }
        for base in bases {
            for n in 0..<6 { ManagedSettingsStore(named: ManagedSettingsStore.Name(n == 0 ? base : "\(base)-\(n)")).clearAllSettings() }
        }
        defaults.set(true, forKey: "shieldStoresV3")
    }
    /// Builds 19–22 mixed apps and websites in "goalie-0"… Clear those once.
    private static func clearMixedStores() {
        let defaults = LockShared.defaults
        guard !defaults.bool(forKey: "shieldStoresV4") else { return }
        for n in 0..<maxStores { ManagedSettingsStore(named: ManagedSettingsStore.Name("goalie-\(n)")).clearAllSettings() }
        defaults.set(true, forKey: "shieldStoresV4")
    }
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
    var days: [Int]?            // the days it applies: 0 = Sunday … 6 = Saturday (none: every day)
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

        // Goals whose period starts today begin again; then each lock is on if today is one of its
        // days and a goal is left (off days: open, whatever the goals say).
        let weekday = (parts.weekday ?? 1) - 1
        var all = configs()
        for index in all.indices {
            for goal in all[index].goals.indices where starting.contains(all[index].goals[goal].period) {
                all[index].goals[goal].done = false
                all[index].goals[goal].progress = all[index].goals[goal].resetProgress
            }
            let days = all[index].days ?? []
            let applies = days.isEmpty || days.contains(weekday)
            all[index].locked = applies && all[index].goals.contains { !$0.done }
        }
        saveConfigs(all)
        Shield.refresh()
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
    var hours: [ScreenHours]? // locked hours: one or more times, each on its own days
    var from: String?    // (before several times: one time, "22:00" to "07:00", on the limit's days)
    var to: String?
    var days: [Int]?     // the days the daily limit applies: 0 = Sunday … 6 = Saturday (none: every day)
    var each: Bool?      // daily limit for each app on its own (true) or all of them combined (none / false)

    /// Whether the daily limit applies on the day of this date.
    func appliesOn(_ date: Date) -> Bool { ScreenHours.on(days, date) }

    /// The locked-hours times, in the order Goalie sent them (their place is in their schedule's name).
    var times: [ScreenHours] {
        if let hours { return hours }
        guard let from, let to else { return [] }
        return [ScreenHours(from: from, to: to, days: days)]
    }
    /// Inside any of the locked hours right now.
    func inWindow(_ date: Date = Date()) -> Bool { times.contains { $0.inWindow(date) } }
    /// The time that has the apps locked right now (the one ending last), for the lock screen.
    func activeTime(_ date: Date = Date()) -> ScreenHours? {
        times.filter { $0.inWindow(date) }.max { $0.minutesLeft(date) < $1.minutesLeft(date) }
    }
}

/// One locked-hours time: "22:00" to "07:00" on its days.
struct ScreenHours: Codable {
    var from: String
    var to: String
    var days: [Int]?

    static func on(_ days: [Int]?, _ date: Date) -> Bool {
        guard let days, !days.isEmpty else { return true }
        return days.contains(Calendar.current.component(.weekday, from: date) - 1)
    }
    func appliesOn(_ date: Date) -> Bool { Self.on(days, date) }

    /// Minutes after midnight for "22:00".
    private static func minutes(_ hhmm: String) -> Int? {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        return parts.count == 2 ? parts[0] * 60 + parts[1] : nil
    }
    var window: (start: Int, end: Int)? {
        guard let start = Self.minutes(from), let end = Self.minutes(to), start != end else { return nil }
        return (start, end)
    }
    private static func now(_ date: Date) -> Int {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    }
    /// Inside these hours right now, on one of its days. Hours that run past midnight (10 PM to
    /// 7 AM) belong to the day they start: Friday's run ends Saturday morning.
    func inWindow(_ date: Date = Date()) -> Bool {
        guard let window else { return false }
        let now = Self.now(date)
        if window.start < window.end { return now >= window.start && now < window.end && appliesOn(date) }
        if now >= window.start { return appliesOn(date) }
        if now < window.end { return appliesOn(date.addingTimeInterval(-86_400)) }
        return false
    }
    func minutesLeft(_ date: Date) -> Int { ((window?.end ?? 0) - Self.now(date) + 1440) % 1440 }
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

    /// The steps to hear about, across the whole day: every 5 minutes for the first 2 hours, then
    /// every 10 (to 4 hours), 15 (to 8), 30 (to 16) and 60, plus the limit itself. (About 75 in all;
    /// it used to stop at 4 hours.)
    static let stepsVersion = "v2" // changing the steps restarts the listening once
    static func steps(limit: Int) -> [Int] {
        var list: [Int] = []
        list += Array(stride(from: 5, through: 120, by: 5))
        list += Array(stride(from: 130, through: 240, by: 10))
        list += Array(stride(from: 255, through: 480, by: 15))
        list += Array(stride(from: 510, through: 960, by: 30))
        list += Array(stride(from: 1020, through: 1380, by: 60))
        if limit > 0 && !list.contains(limit) { list.append(limit) } // always hear the limit itself
        return list.sorted()
    }

    /// A limit's apps are locked for the rest of the day (its combined daily limit was reached).
    /// Only marks it; Shield.refresh() does the locking.
    static func limitLocked(_ key: String) -> Bool {
        (LockShared.defaults.dictionary(forKey: "limitLocked")?[key] as? String) == LockStorage.dayKey()
    }
    static func setLimitLocked(_ key: String, _ on: Bool) {
        var all = LockShared.defaults.dictionary(forKey: "limitLocked") ?? [:]
        if on { all[key] = LockStorage.dayKey() } else { all.removeValue(forKey: key) }
        LockShared.defaults.set(all, forKey: "limitLocked")
    }

    /* Locked hours: their own activity and their own lock, so the daily-minutes lock and the
       locked hours never undo each other. */
    /// iPhone's schedules have to start and end on the same day, so locked hours are scheduled in up
    /// to two parts: "a" (start to 11:59 PM, or start to end on the same day) and "b" (midnight to the
    /// end, for hours that run past midnight). Part "b" belongs to the day before. A limit can have
    /// several times; each time's place goes in the name: "goalie.window.<key>.0a", ".1b"…
    static let maxTimes = 4
    /// Since build 23, one schedule per span of time, shared by every limit with the same hours:
    /// "goalie.hours.1380-1439" (minutes after midnight).
    static func hoursActivity(start: Int, end: Int) -> DeviceActivityName { DeviceActivityName("goalie.hours.\(start)-\(end)") }
    static func hoursSpan(of activity: DeviceActivityName) -> (start: Int, end: Int)? {
        let prefix = "goalie.hours."
        guard activity.rawValue.hasPrefix(prefix) else { return nil }
        let ends = activity.rawValue.dropFirst(prefix.count).split(separator: "-").compactMap { Int($0) }
        return ends.count == 2 ? (ends[0], ends[1]) : nil
    }
    /// The same-day spans a time is scheduled in: "a" (start to end, or start to 11:59 PM) and "b"
    /// (midnight to the end, for hours past midnight). A span under 15 minutes, iPhone's shortest,
    /// is left out.
    static func parts(of time: ScreenHours) -> [(part: String, start: Int, end: Int)] {
        guard let window = time.window else { return [] }
        if window.start < window.end { return [(part: "a", start: window.start, end: window.end)] }
        var list: [(part: String, start: Int, end: Int)] = []
        if 23 * 60 + 59 - window.start >= 15 { list.append((part: "a", start: window.start, end: 23 * 60 + 59)) }
        if window.end >= 15 { list.append((part: "b", start: 0, end: window.end)) }
        return list
    }
    static func windowActivity(_ key: String, time: Int, part: String) -> DeviceActivityName {
        DeviceActivityName("goalie.window.\(key).\(time)\(part)")
    }
    /// Every name a limit's locked hours might be scheduled under (also the older ".a" / ".b" / none).
    static func windowActivities(_ key: String) -> [DeviceActivityName] {
        (0..<maxTimes).flatMap { [windowActivity(key, time: $0, part: "a"), windowActivity(key, time: $0, part: "b")] }
            + [DeviceActivityName("goalie.window.\(key).a"), DeviceActivityName("goalie.window.\(key).b"), DeviceActivityName("goalie.window.\(key)")]
    }
    static func key(ofWindow activity: DeviceActivityName) -> (key: String, time: Int, part: String)? {
        let prefix = "goalie.window."
        guard activity.rawValue.hasPrefix(prefix) else { return nil }
        let rest = String(activity.rawValue.dropFirst(prefix.count))
        if let dot = rest.lastIndex(of: ".") {
            let tail = rest[rest.index(after: dot)...], key = String(rest[..<dot])
            if tail == "a" || tail == "b" { return (key, 0, String(tail)) }
            if let part = tail.last, part == "a" || part == "b", let time = Int(tail.dropLast()) { return (key, time, String(part)) }
        }
        return (rest, 0, "a")
    }
    /// Inside one of a limit's locked-hours times ("<key>#<time>"). Only marks it; Shield.refresh()
    /// does the locking.
    static func windowLocked(_ key: String) -> Bool {
        (LockShared.defaults.stringArray(forKey: "windowLocked") ?? []).contains { $0 == key || $0.hasPrefix("\(key)#") }
    }
    static func setWindowLocked(_ key: String, time: Int, _ on: Bool) {
        var ids = Set(LockShared.defaults.stringArray(forKey: "windowLocked") ?? [])
        ids.remove(key) // (before several times, the key on its own)
        if on { ids.insert("\(key)#\(time)") } else { ids.remove("\(key)#\(time)") }
        LockShared.defaults.set(Array(ids), forKey: "windowLocked")
    }
    /// None of the limit's times lock its apps (its locked hours were turned off, or it was deleted).
    static func clearWindowLocks(_ key: String) {
        let ids = (LockShared.defaults.stringArray(forKey: "windowLocked") ?? []).filter { $0 != key && !$0.hasPrefix("\(key)#") }
        LockShared.defaults.set(ids, forKey: "windowLocked")
    }

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
}
