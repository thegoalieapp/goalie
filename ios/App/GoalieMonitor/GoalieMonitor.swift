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
        if let key = ScreenStorage.key(ofWindow: activity) {
            // Locked hours start: lock, if today is one of the limit's days.
            if ScreenStorage.goals().first(where: { $0.key == key })?.appliesOn(Date()) ?? true {
                ScreenStorage.lockWindow(key)
            }
        } else if let key = ScreenStorage.key(of: activity) {
            ScreenStorage.clearReached(key) // a new day: every app back under its limit
            ScreenStorage.unlockApps(key)
        } else {
            LockStorage.relockForNewPeriods()
        }
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        if let key = ScreenStorage.key(ofWindow: activity) {
            ScreenStorage.unlockWindow(key)
        }
    }

    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)
        guard let key = ScreenStorage.key(of: activity) else { return }
        let goal = ScreenStorage.goals().first(where: { $0.key == key })
        let name = event.rawValue
        if name.hasPrefix("i"), let item = Int(name.dropFirst()) { // one app reached its own limit
            if let goal, goal.lock, goal.appliesOn(Date()) {
                ScreenStorage.markReached(key, item: item)
                ScreenStorage.lockReached(key)
            }
            return
        }
        guard let minutes = Int(name.dropFirst()) else { return } // "m<minutes>": all the apps together
        ScreenStorage.record(key, minutes: minutes)
        if let goal, goal.lock, goal.each != true, goal.limit > 0, minutes >= goal.limit, goal.appliesOn(Date()) {
            ScreenStorage.lockApps(key)
        }
    }
}
