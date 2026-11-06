// Goalie's widgets: the bridge between Goalie (syncWidgets in app.js) and the widget add-on
// (ios/App/GoalieWidget), which can't read Goalie's own storage.
//
//   update({ json })    saves the summary the widgets show and redraws them
//   "openUrl" event     { url }: a widget was tapped (goalie://…), kept until Goalie is listening

import Foundation
import Capacitor
import WidgetKit

@objc(GoalieWidgetsPlugin)
public class GoalieWidgetsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GoalieWidgetsPlugin"
    public let jsName = "GoalieWidgets"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise)
    ]

    static let group = "group.com.thegoalieapp.goalie"
    static let snapshotKey = "widgetSnapshot"
    private static let opened = Notification.Name("goalieWidgetOpened")
    /// A tap that arrived before Goalie's page was ready (opening Goalie from a widget).
    private static var pending: URL?

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(widgetOpened(_:)), name: Self.opened, object: nil)
        if let url = Self.pending {
            Self.pending = nil
            send(url)
        }
    }

    /// The scene hands over goalie:// links here (SceneDelegate).
    static func open(_ url: URL) {
        pending = url
        NotificationCenter.default.post(name: opened, object: url)
    }

    @objc private func widgetOpened(_ note: Notification) {
        guard let url = note.object as? URL else { return }
        Self.pending = nil
        send(url)
    }

    private func send(_ url: URL) {
        notifyListeners("openUrl", data: ["url": url.absoluteString], retainUntilConsumed: true)
    }

    @objc func update(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else { return call.reject("Missing the widget summary") }
        UserDefaults(suiteName: Self.group)?.set(json, forKey: Self.snapshotKey)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}
