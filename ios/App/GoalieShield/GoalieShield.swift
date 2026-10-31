// App locks: the lock screen shown over a locked app. It follows the phone's appearance like Goalie:
// navy text, buttons and logo on a light background in light mode; white on dark in dark mode. It
// names the lock and lists the goals still left, with progress ("Workout · 15/45 minutes").

import ManagedSettings
import ManagedSettingsUI
import UIKit

class GoalieShield: ShieldConfigurationDataSource {
    override func configuration(shielding application: Application) -> ShieldConfiguration {
        screen(app: application.token, category: nil, web: nil)
    }

    override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
        screen(app: application.token, category: category.token, web: nil)
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        screen(app: nil, category: nil, web: webDomain.token)
    }

    override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration {
        screen(app: nil, category: category.token, web: webDomain.token)
    }

    /// A screen-time limit reached comes first (it's the reason for this lock); otherwise the goals lock.
    private func screen(app: ApplicationToken?, category: ActivityCategoryToken?, web: WebDomainToken?) -> ShieldConfiguration {
        if let goal = ScreenStorage.limitGoal(covering: app, category: category, web: web) {
            return limitScreen(for: goal)
        }
        return screen(for: LockStorage.lock(covering: app, category: category, web: web))
    }

    private func limitScreen(for goal: ScreenGoal) -> ShieldConfiguration {
        let dark = UITraitCollection.current.userInterfaceStyle == .dark
        return ShieldConfiguration(
            backgroundBlurStyle: nil,
            backgroundColor: .systemBackground,
            icon: UIImage(named: dark ? "ShieldIcon" : "ShieldIconNavy"),
            title: ShieldConfiguration.Label(text: "\(goal.name): limit reached", color: Self.ink),
            subtitle: ShieldConfiguration.Label(
                text: "You've used your \(goal.limit) minutes for today.\nThese apps unlock at midnight.",
                color: Self.ink.withAlphaComponent(0.85)),
            primaryButtonLabel: ShieldConfiguration.Label(text: "OK", color: Self.paper),
            primaryButtonBackgroundColor: Self.ink)
    }

    private static let navy = UIColor(red: 0x1c / 255, green: 0x2a / 255, blue: 0x4a / 255, alpha: 1)
    /// Navy in light mode, white in dark mode.
    private static let ink = UIColor { $0.userInterfaceStyle == .dark ? .white : navy }
    /// The opposite, for the OK button's text (the button is filled with `ink`).
    private static let paper = UIColor { $0.userInterfaceStyle == .dark ? navy : .white }

    private func screen(for match: LockConfig?) -> ShieldConfiguration {
        // The lock this app belongs to; if Apple's codes don't say, every lock that's on, so the goals
        // left always show.
        let locks = match.map { [$0] } ?? LockStorage.configs().filter(\.locked)
        let dark = UITraitCollection.current.userInterfaceStyle == .dark
        let names = locks.map(\.name).filter { !$0.isEmpty }
        let title = names.count == 1 ? "\(names[0]) is locked" : "Locked by Goalie"

        var seen = Set<String>()
        let left = locks.flatMap(\.goals).filter { !$0.done && seen.insert($0.name).inserted }
        // (No locks to read at all means the shared App Group isn't reachable: say so differently.)
        // A lock screen can't open an app (Apple's rule), so it says where to go instead.
        let subtitle = locks.isEmpty
            ? "Finish your goals in Goalie to unlock."
            : left.isEmpty
                ? "Your goals are done. Open Goalie to unlock."
                : (["Finish \(left.count == 1 ? "this goal" : "these goals") to unlock:"]
                    + left.map { "\($0.name) · \($0.progress)" }
                    + ["", "Open Goalie to log your progress."])
                    .joined(separator: "\n")

        return ShieldConfiguration(
            backgroundBlurStyle: nil,
            backgroundColor: .systemBackground,
            icon: UIImage(named: dark ? "ShieldIcon" : "ShieldIconNavy"),
            title: ShieldConfiguration.Label(text: title, color: Self.ink),
            subtitle: ShieldConfiguration.Label(text: subtitle, color: Self.ink.withAlphaComponent(0.85)),
            primaryButtonLabel: ShieldConfiguration.Label(text: "OK", color: Self.paper),
            primaryButtonBackgroundColor: Self.ink)
    }
}
