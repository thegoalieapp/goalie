// App locks and screen-time limits: the re-locker. iPhone wakes it even when Goalie is closed:
// - at the start of each day: locks again every lock whose goals' period just restarted, and lifts
//   yesterday's daily-limit locks
// - when a limit's apps reach the next step today (5, 10, 15… minutes, all of them together):
//   records it, and locks the apps once a combined daily limit is reached
// - when one app reaches its own daily limit (limits set to "each"): locks just that app
// - when a limit's locked hours start and end (10 PM to 7 AM, say): locks and unlocks its apps
// All of it only on the limit's days.

import DeviceActivity
import Foundation

class GoalieMonitor: DeviceActivityMonitor {
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        if let span = ScreenStorage.hoursSpan(of: activity) {
            // Locked hours start, for every limit with these hours, on that time's days. The
            // after-midnight part ("b") belongs to the night before.
            for (key, n, time, part) in Self.times(in: span) {
                let day = part == "b" ? Date().addingTimeInterval(-86_400) : Date()
                if time.appliesOn(day) { ScreenStorage.setWindowLocked(key, time: n, true) }
            }
            Shield.refresh()
        } else if let (key, n, part) = ScreenStorage.key(ofWindow: activity) { // (before build 23)
            // One of the locked-hours times starts: lock, if it's one of that time's days. The
            // after-midnight part ("b") belongs to the night before.
            let day = part == "b" ? Date().addingTimeInterval(-86_400) : Date()
            if Self.time(key, n)?.appliesOn(day) ?? true {
                ScreenStorage.setWindowLocked(key, time: n, true)
                Shield.refresh()
            }
        } else if let key = ScreenStorage.key(of: activity) {
            ScreenStorage.clearReached(key) // a new day: every app back under its limit
            ScreenStorage.setLimitLocked(key, false)
            Shield.refresh()
        } else {
            LockStorage.relockForNewPeriods()
        }
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        if let span = ScreenStorage.hoursSpan(of: activity) {
            for (key, n, time, part) in Self.times(in: span) {
                // Hours that run past midnight stay locked from 11:59 PM into the morning part.
                if part == "a", let window = time.window, window.start > window.end, window.end >= 15 { continue }
                ScreenStorage.setWindowLocked(key, time: n, false)
            }
            Shield.refresh()
        } else if let (key, n, part) = ScreenStorage.key(ofWindow: activity) { // (before build 23)
            // Hours that run past midnight stay locked from 11:59 PM into the morning part.
            if part == "a", let window = Self.time(key, n)?.window, window.start > window.end, window.end >= 15 { return }
            ScreenStorage.setWindowLocked(key, time: n, false)
            Shield.refresh()
        }
    }

    /// Every limit's locked-hours time scheduled in this span, and which part of it the span is.
    private static func times(in span: (start: Int, end: Int)) -> [(key: String, n: Int, time: ScreenHours, part: String)] {
        var found: [(key: String, n: Int, time: ScreenHours, part: String)] = []
        for goal in ScreenStorage.goals() {
            for (n, time) in goal.times.prefix(ScreenStorage.maxTimes).enumerated() {
                for p in ScreenStorage.parts(of: time) where p.start == span.start && p.end == span.end {
                    found.append((key: goal.key, n: n, time: time, part: p.part))
                }
            }
        }
        return found
    }

    /// A limit's locked-hours time, by its place.
    private static func time(_ key: String, _ n: Int) -> ScreenHours? {
        guard let times = ScreenStorage.goals().first(where: { $0.key == key })?.times, n < times.count else { return nil }
        return times[n]
    }

    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)
        guard let key = ScreenStorage.key(of: activity) else { return }
        let goal = ScreenStorage.goals().first(where: { $0.key == key })
        let name = event.rawValue
        if name.hasPrefix("i"), let item = Int(name.dropFirst()) { // one app reached its own limit
            if let goal, goal.lock, goal.appliesOn(Date()) {
                ScreenStorage.markReached(key, item: item)
                Shield.refresh()
            }
            return
        }
        guard let minutes = Int(name.dropFirst()) else { return } // "m<minutes>": all the apps together
        ScreenStorage.record(key, minutes: minutes)
        if let goal, goal.lock, goal.each != true, goal.limit > 0, minutes >= goal.limit, goal.appliesOn(Date()) {
            ScreenStorage.setLimitLocked(key, true)
            Shield.refresh()
        }
    }
}
