// App locks: the re-locker. iPhone wakes it at the start of each day (Goalie schedules this), even
// when Goalie is closed, and it locks again every lock whose goals' period just restarted.

import DeviceActivity
import Foundation

class GoalieMonitor: DeviceActivityMonitor {
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        LockStorage.relockForNewPeriods()
    }
}
