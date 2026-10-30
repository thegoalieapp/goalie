import Capacitor

/// Goalie's main screen: Capacitor's web view, plus Goalie's own native plugins.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(GoalieLocksPlugin())
    }
}
