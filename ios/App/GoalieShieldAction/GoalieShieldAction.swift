// App locks: the lock screen's buttons. "OK" closes the locked app. "Open Goalie" also sends a
// notification that opens Goalie when tapped (a lock screen can't open another app itself).

import ManagedSettings
import UserNotifications

class GoalieShieldAction: ShieldActionDelegate {
    override func handle(action: ShieldAction, for application: ApplicationToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        respond(to: action, completionHandler)
    }

    override func handle(action: ShieldAction, for webDomain: WebDomainToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        respond(to: action, completionHandler)
    }

    override func handle(action: ShieldAction, for category: ActivityCategoryToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        respond(to: action, completionHandler)
    }

    private func respond(to action: ShieldAction, _ completionHandler: @escaping (ShieldActionResponse) -> Void) {
        guard action == .secondaryButtonPressed else { return completionHandler(.close) }
        let content = UNMutableNotificationContent()
        content.title = "Goalie"
        content.body = "Tap to open Goalie and finish your goals."
        let request = UNNotificationRequest(identifier: "goalie.open", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in completionHandler(.close) }
    }
}
