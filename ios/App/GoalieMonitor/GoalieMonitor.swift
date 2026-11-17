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
    /* Locked hours: when one starts or ends, what's locked is worked out from the clock and each
       time's days (Shield.wanted), half a minute ahead, so a wake-up a moment early or late still
       lands on the right side of the boundary, and two times meeting (5 AM–11 PM ending as 11 PM–6 AM
       starts) give the same answer in either order. iPhone can wake this for both at once, so each
       wake-up runs one at a time (LockShared.one). */
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        LockShared.one {
            if ScreenStorage.hoursSpan(of: activity) != nil || ScreenStorage.key(ofWindow: activity) != nil {
                ShieldLog.add("Locked hours start (\(activity.rawValue))")
                Shield.refresh(at: Date().addingTimeInterval(30), why: "Locked hours start")
            } else if let key = ScreenStorage.key(of: activity) {
                ScreenStorage.clearReached(key) // a new day: every app back under its limit
                ScreenStorage.setLimitLocked(key, false)
                Shield.refresh(why: "New day for a limit")
            } else {
                LockStorage.relockForNewPeriods()
            }
        }
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        LockShared.one {
            if ScreenStorage.hoursSpan(of: activity) != nil || ScreenStorage.key(ofWindow: activity) != nil {
                ShieldLog.add("Locked hours end (\(activity.rawValue))")
                Shield.refresh(at: Date().addingTimeInterval(30), why: "Locked hours end")
            }
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
        LockShared.one { reached(event, activity: activity) }
    }

    private func reached(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        guard let key = ScreenStorage.key(of: activity) else { return }
        let goal = ScreenStorage.goals().first(where: { $0.key == key })
        let name = event.rawValue
        if name.hasPrefix("i"), let item = Int(name.dropFirst()) { // one app reached its own limit
            if let goal, goal.lock, goal.appliesOn(Date()) {
                ScreenStorage.markReached(key, item: item)
                Shield.refresh(why: "An app reached its own limit")
            }
            return
        }
        guard let minutes = Int(name.dropFirst()) else { return } // "m<minutes>": all the apps together
        ScreenStorage.record(key, minutes: minutes)
        if let goal, goal.lock, goal.each != true, goal.limit > 0, minutes >= goal.limit, goal.appliesOn(Date()) {
            ScreenStorage.setLimitLocked(key, true)
            Shield.refresh(why: "Daily limit reached")
        }
    }
}
