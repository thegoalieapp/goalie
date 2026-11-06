// App locks: the bridge between Goalie (locks.js) and Apple's Screen Time.
//
//   authorization()          → { status }   approved / denied / notDetermined
//   requestAuthorization()   → { status }   "Allow Goalie to use Screen Time?"
//   pickApps({ id, locked }) → { apps, categories, sites, full, cancelled }   Apple's app picker
//                              (up to 50 of each; full: one of them is at 50)
//   showApps({ id })         a list of what's picked, with names and icons (drawn by iPhone)
//   update({ json })         saves every lock (from Goalie) and locks or unlocks its apps
//   remove({ id })           deletes a lock and unlocks its apps
//
// While a lock is locked it can only get stricter, so picking apps then adds to what it had.

import Foundation
import Capacitor
import SwiftUI
import FamilyControls
import ManagedSettings
import DeviceActivity

@objc(GoalieLocksPlugin)
public class GoalieLocksPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GoalieLocksPlugin"
    public let jsName = "GoalieLocks"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickApps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showApps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "screenGoals", returnType: CAPPluginReturnPromise)
    ]

    private static let daily = DeviceActivityName("goalie.daily")

    /// Right after Goalie starts, iPhone reports "not decided yet" for a moment before it has looked up
    /// the real answer, so give it up to 4 seconds to settle.
    @objc func authorization(_ call: CAPPluginCall) {
        Task { @MainActor in
            for _ in 0..<40 where AuthorizationCenter.shared.authorizationStatus == .notDetermined {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            call.resolve(["status": Self.status()])
        }
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            } catch {
                // Declined or unavailable: the status below says which.
            }
            if AuthorizationCenter.shared.authorizationStatus == .approved {
                Shield.forget() // back on after being off: put every lock back
                Shield.refresh()
            }
            call.resolve(["status": Self.status()])
        }
    }

    @objc func pickApps(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("Missing lock id") }
        let locked = call.getBool("locked") ?? false
        DispatchQueue.main.async {
            let before = LockStorage.selection(id) ?? FamilyActivitySelection()
            var host: UIViewController?
            let picker = AppPickerView(selection: before, onDone: { picked in
                var chosen = picked
                if locked { // can only add while locked
                    chosen.applicationTokens.formUnion(before.applicationTokens)
                    chosen.categoryTokens.formUnion(before.categoryTokens)
                    chosen.webDomainTokens.formUnion(before.webDomainTokens)
                }
                LockStorage.saveSelection(chosen, for: id)
                Shield.refresh()
                if id.hasPrefix("screen-") { // a screen-time goal's apps changed: listen again
                    LockShared.defaults.removeObject(forKey: "screenSig-\(id.dropFirst("screen-".count))")
                }
                host?.dismiss(animated: true)
                var result = Self.counts(chosen)
                result["full"] = AppPickerView.isFull(chosen)
                call.resolve(result)
            }, onCancel: {
                host?.dismiss(animated: true)
                var result = Self.counts(before)
                result["cancelled"] = true
                call.resolve(result)
            })
            let controller = UIHostingController(rootView: picker)
            host = controller
            self.bridge?.viewController?.present(controller, animated: true)
        }
    }

    /// The picked apps, categories and websites, by name. Apple's labels draw the names and icons;
    /// Goalie itself still never learns which apps they are.
    @objc func showApps(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("Missing lock id") }
        DispatchQueue.main.async {
            let picked = LockStorage.selection(id) ?? FamilyActivitySelection()
            var host: UIViewController?
            let list = PickedAppsView(selection: picked, onDone: { host?.dismiss(animated: true) })
            let controller = UIHostingController(rootView: list)
            host = controller
            self.bridge?.viewController?.present(controller, animated: true)
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard let json = call.getString("json")?.data(using: .utf8),
              let payload = try? JSONDecoder().decode(UpdatePayload.self, from: json) else {
            return call.reject("Couldn't read the locks")
        }
        LockStorage.weekStart = payload.weekStart
        LockStorage.saveConfigs(payload.locks)
        Shield.refresh()
        Self.monitorNewDays(payload.locks.isEmpty == false)
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("Missing lock id") }
        LockStorage.removeSelection(for: id)
        let rest = LockStorage.configs().filter { $0.id != id }
        LockStorage.saveConfigs(rest)
        Shield.refresh()
        Self.monitorNewDays(!rest.isEmpty)
        call.resolve()
    }

    /// Screen-time goals: listen for each one's apps reaching every step today, stop listening for
    /// goals that are gone, lock or unlock limit goals, and send back the steps recorded so far:
    /// { usage: { key: { "2026-10-30": { minutes, at } } } }.
    @objc func screenGoals(_ call: CAPPluginCall) {
        guard let json = call.getString("json")?.data(using: .utf8),
              let goals = try? JSONDecoder().decode([ScreenGoal].self, from: json) else {
            return call.reject("Couldn't read the screen-time goals")
        }
        let center = DeviceActivityCenter()
        let keys = Set(goals.map(\.key))
        for gone in ScreenStorage.goals() where !keys.contains(gone.key) {
            center.stopMonitoring([ScreenStorage.activity(gone.key)] + ScreenStorage.windowActivities(gone.key))
            ScreenStorage.setLimitLocked(gone.key, false)
            ScreenStorage.clearWindowLocks(gone.key)
            LockShared.defaults.removeObject(forKey: "screenSig-\(gone.key)")
        }
        ScreenStorage.saveGoals(goals)
        var problems: [String: String] = [:] // schedules iPhone refused, shown on the limit's card
        for goal in goals {
            guard let picked = ScreenStorage.selection(goal.key) else { continue }
            // Start (or restart) listening only when the apps or the limit changed: restarting
            // mid-day would hear today's steps again.
            let each = goal.each == true && goal.limit > 0
            let sig = "\(ScreenStorage.stepsVersion)-\(goal.limit)\(each ? "-each" : "")"
            let activity = ScreenStorage.activity(goal.key)
            if LockShared.defaults.string(forKey: "screenSig-\(goal.key)") != sig || !center.activities.contains(activity) {
                var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
                for minutes in ScreenStorage.steps(limit: goal.limit) {
                    events[DeviceActivityEvent.Name("m\(minutes)")] = Self.event(picked, minutes: minutes)
                }
                if each { // every app, category and website: its own "reached the limit" signal
                    let items = ScreenStorage.Items(apps: Array(picked.applicationTokens), categories: Array(picked.categoryTokens), webs: Array(picked.webDomainTokens))
                    ScreenStorage.saveItems(items, for: goal.key)
                    var n = 0
                    for app in items.apps { events[DeviceActivityEvent.Name("i\(n)")] = Self.event(apps: [app], minutes: goal.limit); n += 1 }
                    for category in items.categories { events[DeviceActivityEvent.Name("i\(n)")] = Self.event(categories: [category], minutes: goal.limit); n += 1 }
                    for web in items.webs { events[DeviceActivityEvent.Name("i\(n)")] = Self.event(webs: [web], minutes: goal.limit); n += 1 }
                    ScreenStorage.clearReached(goal.key) // the list changed: its numbers start over
                }
                center.stopMonitoring([activity])
                do {
                    try center.startMonitoring(activity, during: DeviceActivitySchedule(
                        intervalStart: DateComponents(hour: 0, minute: 0),
                        intervalEnd: DateComponents(hour: 23, minute: 59),
                        repeats: true), events: events)
                    LockShared.defaults.set(sig, forKey: "screenSig-\(goal.key)")
                } catch {
                    problems[goal.key] = "Time tracking couldn’t start (\(error.localizedDescription))" // tried again next time
                }
            }
            // Combined limit reached today: locked until midnight. ("Each" limits lock just the apps
            // at their own limit; Shield.refresh() reads those.)
            ScreenStorage.setLimitLocked(goal.key, goal.lock && goal.limit > 0 && !each && goal.appliesOn(Date())
                && ScreenStorage.minutesToday(goal.key) >= goal.limit)
            // Locked hours: locked or not right now, whichever the clock says.
            ScreenStorage.clearWindowLocks(goal.key)
            for (n, time) in goal.times.prefix(ScreenStorage.maxTimes).enumerated() where time.inWindow() {
                ScreenStorage.setWindowLocked(goal.key, time: n, true)
            }
        }
        for (key, problem) in Self.scheduleHours(goals, center: center) where problems[key] == nil { problems[key] = problem }
        Shield.refresh() // everything above, in one go (only told to iPhone if something changed)
        var usage: [String: Any] = [:]
        for (key, days) in ScreenStorage.usage() {
            usage[key] = days.mapValues { ["minutes": $0.minutes, "at": $0.at] }
        }
        // How many apps reached their own limit today ("each" limits), for the cards in Goalie.
        var reached: [String: Any] = [:]
        for goal in goals where goal.each == true { reached[goal.key] = ScreenStorage.reachedToday(goal.key).count }
        call.resolve(["usage": usage, "reached": reached, "problems": problems])
    }

    /// Locked hours: iPhone wakes the re-locker when they start and end, every day (even when they
    /// run past midnight). Each span of time has one schedule, shared by every limit with the same
    /// hours: iPhone only lets an app run so many schedules, and one per limit ran out. Returns, by
    /// limit, why iPhone wouldn't schedule its hours.
    private static func scheduleHours(_ goals: [ScreenGoal], center: DeviceActivityCenter) -> [String: String] {
        var needed: [String: (start: Int, end: Int, keys: Set<String>)] = [:]
        for goal in goals where ScreenStorage.selection(goal.key) != nil {
            for time in goal.times.prefix(ScreenStorage.maxTimes) {
                for part in ScreenStorage.parts(of: time) {
                    let name = ScreenStorage.hoursActivity(start: part.start, end: part.end).rawValue
                    needed[name, default: (start: part.start, end: part.end, keys: [])].keys.insert(goal.key)
                }
            }
        }
        // Hours no limit uses any more, and every limit's own schedules from builds before 23.
        let stale = center.activities.filter {
            $0.rawValue.hasPrefix("goalie.window.") || ($0.rawValue.hasPrefix("goalie.hours.") && needed[$0.rawValue] == nil)
        }
        if !stale.isEmpty { center.stopMonitoring(stale) }
        var problems: [String: String] = [:]
        let running = Set(center.activities.map(\.rawValue))
        for (name, span) in needed where !running.contains(name) {
            do {
                try center.startMonitoring(DeviceActivityName(name), during: DeviceActivitySchedule(
                    intervalStart: DateComponents(hour: span.start / 60, minute: span.start % 60),
                    intervalEnd: DateComponents(hour: span.end / 60, minute: span.end % 60),
                    repeats: true))
            } catch {
                let full = "\(error)".contains("excessiveActivities")
                let text = full
                    ? "iPhone has no room for more schedules. Use the same locked hours as another limit, or remove a limit or a time"
                    : "Locked hours couldn’t be scheduled (\(error.localizedDescription))"
                for key in span.keys { problems[key] = text }
            }
        }
        return problems
    }

    /// "These apps reached this many minutes today", counting use from before Goalie started
    /// listening where iOS allows it.
    private static func event(_ picked: FamilyActivitySelection, minutes: Int) -> DeviceActivityEvent {
        event(apps: picked.applicationTokens, categories: picked.categoryTokens, webs: picked.webDomainTokens, minutes: minutes)
    }

    private static func event(apps: Set<ApplicationToken> = [], categories: Set<ActivityCategoryToken> = [],
                              webs: Set<WebDomainToken> = [], minutes: Int) -> DeviceActivityEvent {
        let threshold = DateComponents(minute: minutes)
        if #available(iOS 17.4, *) {
            return DeviceActivityEvent(applications: apps, categories: categories, webDomains: webs,
                                       threshold: threshold, includesPastActivity: true)
        }
        return DeviceActivityEvent(applications: apps, categories: categories, webDomains: webs, threshold: threshold)
    }

    private struct UpdatePayload: Decodable {
        var locks: [LockConfig]
        var weekStart: Int
    }

    private static func status() -> String {
        switch AuthorizationCenter.shared.authorizationStatus {
        case .approved: return "approved"
        case .denied: return "denied"
        default: return "notDetermined"
        }
    }

    private static func counts(_ selection: FamilyActivitySelection) -> [String: Any] {
        ["apps": selection.applicationTokens.count,
         "categories": selection.categoryTokens.count,
         "sites": selection.webDomainTokens.count]
    }

    /// The re-locker wakes at the start of every day (see GoalieMonitor). Today counts as already
    /// handled, so starting it now never locks something that was just unlocked.
    private static func monitorNewDays(_ on: Bool) {
        let center = DeviceActivityCenter()
        guard on else { center.stopMonitoring([daily]); return }
        guard !center.activities.contains(daily) else { return }
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        LockStorage.lastRelockDay = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        let schedule = DeviceActivitySchedule(
            intervalStart: DateComponents(hour: 0, minute: 0),
            intervalEnd: DateComponents(hour: 23, minute: 59),
            repeats: true)
        try? center.startMonitoring(daily, during: schedule)
    }
}

/// Apple's app picker, with Cancel and Done. One lock or limit holds up to 50 apps, 50 websites
/// and 50 categories (iPhone's own limit for each list): past that, Done waits until some are
/// removed. Apple's picker can't stop the ticking itself.
private struct AppPickerView: View {
    static let most = 50
    @State var selection: FamilyActivitySelection
    let onDone: (FamilyActivitySelection) -> Void
    let onCancel: () -> Void

    static func isFull(_ s: FamilyActivitySelection) -> Bool {
        s.applicationTokens.count >= most || s.webDomainTokens.count >= most || s.categoryTokens.count >= most
    }
    /// "Remove 11 apps and 14 websites to continue." (nothing when it fits)
    private var tooMany: String? {
        let counts = [(selection.applicationTokens.count, "app"), (selection.webDomainTokens.count, "website"),
                      (selection.categoryTokens.count, "category")]
        let over = counts.filter { $0.0 > Self.most }.map { item -> String in
            let n = item.0 - Self.most
            let plural = item.1 == "category" ? "categories" : item.1 + "s"
            return "\(n) " + (n == 1 ? item.1 : plural)
        }
        return over.isEmpty ? nil : "That’s more than one lock can hold. Remove \(over.joined(separator: " and ")) to continue. You can lock the rest with another one."
    }

    var body: some View {
        NavigationView {
            FamilyActivityPicker(headerText: "Up to 50 apps, 50 websites and 50 categories", selection: $selection)
                .navigationTitle("Choose apps to lock")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { onDone(selection) }.disabled(tooMany != nil) }
                }
                .safeAreaInset(edge: .bottom) {
                    if let tooMany {
                        Text(tooMany)
                            .font(.callout.weight(.semibold))
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(Color.red)
                    }
                }
        }
    }
}

/// What a lock or limit has picked: categories, apps and websites.
private struct PickedAppsView: View {
    let selection: FamilyActivitySelection
    let onDone: () -> Void

    var body: some View {
        NavigationView {
            List {
                if !selection.categoryTokens.isEmpty {
                    Section(header: Text("Categories")) {
                        ForEach(Array(selection.categoryTokens), id: \.self) { token in Label(token) }
                    }
                }
                if !selection.applicationTokens.isEmpty {
                    Section(header: Text("Apps")) {
                        ForEach(Array(selection.applicationTokens), id: \.self) { token in Label(token) }
                    }
                }
                if !selection.webDomainTokens.isEmpty {
                    Section(header: Text("Websites")) {
                        ForEach(Array(selection.webDomainTokens), id: \.self) { token in Label(token) }
                    }
                }
            }
            .navigationTitle("Locked apps")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) }
            }
        }
    }
}
