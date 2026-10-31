// App locks: the lock screen's button. "OK" closes the locked app. (A lock screen can't open
// another app, so there's no "Open Goalie" button; the lock screen says to open Goalie instead.)

import ManagedSettings

class GoalieShieldAction: ShieldActionDelegate {
    override func handle(action: ShieldAction, for application: ApplicationToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(.close)
    }

    override func handle(action: ShieldAction, for webDomain: WebDomainToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(.close)
    }

    override func handle(action: ShieldAction, for category: ActivityCategoryToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(.close)
    }
}
