// App locks: the bridge between Goalie (locks.js) and Apple's Screen Time.
//
//   authorization()          → { status }   approved / denied / notDetermined
//   requestAuthorization()   → { status }   "Allow Goalie to use Screen Time?"
//   pickApps({ id, locked }) → { apps, categories, sites, cancelled }   Apple's app picker
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
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "screenGoals", returnType: CAPPluginReturnPromise)
    ]

    private static let daily = DeviceActivityName("goalie.daily")

    /// Right after Goalie starts, iPhone reports "not decided yet" for a moment before it has looked up
    /// the real answer, so give it up to 2 seconds to settle.
    @objc func authorization(_ call: CAPPluginCall) {
        Task { @MainActor in
            for _ in 0..<20 where AuthorizationCenter.shared.authorizationStatus == .notDetermined {
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
                if let lock = LockStorage.configs().first(where: { $0.id == id }) { LockStorage.apply(lock) }
                if id.hasPrefix("screen-") { // a screen-time goal's apps changed: listen again
                    LockShared.defaults.removeObject(forKey: "screenSig-\(id.dropFirst("screen-".count))")
                }
                host?.dismiss(animated: true)
                call.resolve(Self.counts(chosen))
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

    @objc func update(_ call: CAPPluginCall) {
        guard let json = call.getString("json")?.data(using: .utf8),
              let payload = try? JSONDecoder().decode(UpdatePayload.self, from: json) else {
            return call.reject("Couldn't read the locks")
        }
        LockStorage.weekStart = payload.weekStart
        LockStorage.saveConfigs(payload.locks)
        payload.locks.forEach(LockStorage.apply)
        Self.monitorNewDays(payload.locks.isEmpty == false)
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("Missing lock id") }
        LockStorage.clear(id)
        LockStorage.removeSelection(for: id)
        let rest = LockStorage.configs().filter { $0.id != id }
        LockStorage.saveConfigs(rest)
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
            ScreenStorage.unlockApps(gone.key)
            ScreenStorage.unlockWindow(gone.key)
            LockShared.defaults.removeObject(forKey: "screenSig-\(gone.key)")
            LockShared.defaults.removeObject(forKey: "windowSig-\(gone.key)")
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
            if !goal.lock || goal.limit == 0 || !goal.appliesOn(Date()) {
                ScreenStorage.unlockApps(goal.key)
            } else if each {
                ScreenStorage.lockReached(goal.key) // just the apps at their own limit (none: nothing locked)
            } else if ScreenStorage.minutesToday(goal.key) >= goal.limit {
                ScreenStorage.lockApps(goal.key)
            } else {
                ScreenStorage.unlockApps(goal.key)
            }
            if let problem = Self.scheduleWindow(goal, picked: picked, center: center) { problems[goal.key] = problem }
        }
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
    /// run past midnight); and right now the apps are locked or not, whichever the clock says.
    /// Returns why iPhone wouldn't schedule them, if it wouldn't. Its schedules have to start and end
    /// on the same day, so hours that run past midnight go in two parts: start to 11:59 PM, then
    /// midnight to the end (a part under 15 minutes, iPhone's shortest, is left out).
    private static func scheduleWindow(_ goal: ScreenGoal, picked: FamilyActivitySelection, center: DeviceActivityCenter) -> String? {
        let all = ScreenStorage.windowActivities(goal.key)
        let sigKey = "windowSig-\(goal.key)"
        guard let window = goal.window else {
            center.stopMonitoring(all)
            ScreenStorage.unlockWindow(goal.key)
            LockShared.defaults.removeObject(forKey: sigKey)
            return nil
        }
        var parts: [(name: DeviceActivityName, start: Int, end: Int)] = []
        if window.start < window.end {
            parts.append((ScreenStorage.windowActivity(goal.key, part: "a"), window.start, window.end))
        } else {
            if 23 * 60 + 59 - window.start >= 15 { parts.append((ScreenStorage.windowActivity(goal.key, part: "a"), window.start, 23 * 60 + 59)) }
            if window.end >= 15 { parts.append((ScreenStorage.windowActivity(goal.key, part: "b"), 0, window.end)) }
        }
        var problem: String?
        let sig = "v2-\(window.start)-\(window.end)"
        if LockShared.defaults.string(forKey: sigKey) != sig || parts.contains(where: { !center.activities.contains($0.name) }) {
            center.stopMonitoring(all)
            for part in parts {
                do {
                    try center.startMonitoring(part.name, during: DeviceActivitySchedule(
                        intervalStart: DateComponents(hour: part.start / 60, minute: part.start % 60),
                        intervalEnd: DateComponents(hour: part.end / 60, minute: part.end % 60),
                        repeats: true))
                } catch {
                    problem = "Locked hours couldn’t be scheduled (\(error.localizedDescription))"
                }
            }
            if problem == nil { LockShared.defaults.set(sig, forKey: sigKey) }
        }
        if goal.inWindow() { ScreenStorage.lockWindow(goal.key) } else { ScreenStorage.unlockWindow(goal.key) }
        return problem
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

/// Apple's app picker, with Cancel and Done.
private struct AppPickerView: View {
    @State var selection: FamilyActivitySelection
    let onDone: (FamilyActivitySelection) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationView {
            FamilyActivityPicker(selection: $selection)
                .navigationTitle("Choose apps to lock")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { onDone(selection) } }
                }
        }
    }
}
