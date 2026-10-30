// App locks: the lock screen shown over a locked app, in Goalie's navy. It names the lock and lists
// its goals with progress ("• Workout 15/45 min", "✓ Scripture study").

import ManagedSettings
import ManagedSettingsUI
import UIKit

class GoalieShield: ShieldConfigurationDataSource {
    override func configuration(shielding application: Application) -> ShieldConfiguration {
        screen(for: LockStorage.lock(covering: application.token, category: nil))
    }

    override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
        screen(for: LockStorage.lock(covering: application.token, category: category.token))
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        screen(for: LockStorage.lock(covering: nil, category: nil, web: webDomain.token))
    }

    override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration {
        screen(for: LockStorage.lock(covering: nil, category: category.token, web: webDomain.token))
    }

    private func screen(for lock: LockConfig?) -> ShieldConfiguration {
        let navy = UIColor(red: 0x1c / 255, green: 0x2a / 255, blue: 0x4a / 255, alpha: 1)
        let title = lock.map { $0.name.isEmpty ? "Locked by Goalie" : "\($0.name) is locked" } ?? "Locked by Goalie"
        var lines = ["Finish your goals in Goalie to unlock."]
        if let goals = lock?.goals, !goals.isEmpty {
            lines = ["Finish these goals in Goalie to unlock:"]
            lines += goals.map { "\($0.done ? "✓" : "•") \($0.name)  \($0.progress)" }
        }
        return ShieldConfiguration(
            backgroundBlurStyle: nil,
            backgroundColor: navy,
            icon: UIImage(named: "ShieldIcon"),
            title: ShieldConfiguration.Label(text: title, color: .white),
            subtitle: ShieldConfiguration.Label(text: lines.joined(separator: "\n"), color: UIColor.white.withAlphaComponent(0.85)),
            primaryButtonLabel: ShieldConfiguration.Label(text: "OK", color: navy),
            primaryButtonBackgroundColor: .white,
            secondaryButtonLabel: ShieldConfiguration.Label(text: "Open Goalie", color: .white))
    }
}
