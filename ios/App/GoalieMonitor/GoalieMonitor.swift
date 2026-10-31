// App locks and screen-time goals: the re-locker. iPhone wakes it even when Goalie is closed:
// - at the start of each day: locks again every lock whose goals' period just restarted, and lifts
//   yesterday's screen-time limit locks
// - when a screen-time goal's apps reach the next step today (5, 10, 15… minutes): records it, and
//   locks the apps once a limit goal reaches its limit (if asked to)

import DeviceActivity
import Foundation

class GoalieMonitor: DeviceActivityMonitor {
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        if let key = ScreenStorage.key(of: activity) {
            ScreenStorage.unlockApps(key) // a new day: back under the limit
        } else {
            LockStorage.relockForNewPeriods()
        }
    }

    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)
        guard let key = ScreenStorage.key(of: activity), let minutes = Int(event.rawValue.dropFirst()) else { return }
        ScreenStorage.record(key, minutes: minutes)
        if let goal = ScreenStorage.goals().first(where: { $0.key == key }), goal.lock, goal.limit > 0, minutes >= goal.limit {
            ScreenStorage.lockApps(key)
        }
    }
}
