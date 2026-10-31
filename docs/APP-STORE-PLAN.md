# Goalie → App Store / Google Play: plan and decisions

Notes for whoever picks this up next (e.g. Claude Code on the Mac). Everything below was decided with the owner on 2026-10-19 – 2026-10-21.

## Where things stand
- Goalie is a working PWA (vanilla JS: `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `fonts/`, `icons/`), live at https://knottyapparel1-cmd.github.io/goalie/ (GitHub Pages, repo `knottyapparel1-cmd/goalie`, branch `main`).
- Current web version: v85. The version lives in three places: `CACHE` in `sw.js`, `<meta name="goalie-version">` in `index.html`, and `version.json`.
- The owner's real data lives in the home-screen web app on their iPhone. It moves to the native app with Settings → Export, then Import. Never commit backup files (`goalie-backup-*.json` is gitignored).

## Working rules
- **Never push to GitHub unless the owner says "push".** Commit locally, test, then wait.
- The web app must never update itself silently. It asks: Update now, or schedule it. Keep it that way.
- Test changes on a phone-sized screen before calling them done.

## Decisions
- **Wrapper: Capacitor** (not Ionic UI, not a rewrite). Keep the existing HTML/CSS/JS as the app.
- **Target date: the App Store by 2026-11-01**, with everything included. Android (Google Play) follows from the same code; iPhone comes first.
- **Sign-in: Google and Apple** (Apple is required when Google is offered). The purpose is **automatic backup and sync across devices**. Sharing with other people was not chosen.
- **Backend: Firebase** (Auth plus Firestore), per-user data, with security rules so only the owner can read their data. Handle the first sign-in merge, local vs cloud, explicitly.
- **App locks (iOS only)**, using Screen Time APIs (FamilyControls, ManagedSettings, DeviceActivity), as a custom Capacitor plugin in Swift:
  - Apps are picked with Apple's FamilyActivityPicker (any app, or categories like Social).
  - Each lock picks its own apps **and** its own goals. There can be several locks.
  - A lock lifts when all of its goals are completed. "Completed" uses the same rule as the app: increase goals reach the target, decrease goals stay within the limit, ✓/✗ goals are checked.
  - **Re-locking follows each goal's period** (daily goals re-lock each morning, weekly goals each new week, and so on). This needs a DeviceActivityMonitor extension so it happens even when Goalie is closed.
  - **No emergency unlocks.** (The user can still revoke Screen Time permission in iOS Settings; Apple requires that.)
  - **While a lock is locked, it can only get stricter:** apps and goals can be added, but not removed, and the lock can't be deleted until it unlocks. (Decided 2026-10-29.)
  - **Any goal can unlock a lock:** daily, weekly, monthly, yearly and by-date goals alike. (Decided 2026-10-29.)
  - **The lock screen lists the goals still left, with progress** (e.g. "Workout 15/45 min · Scripture ✓"), plus a line to open Goalie. Only an OK button: Apple doesn't let a lock screen open an app, so "Open Goalie" was removed (2026-10-30). (Decided 2026-10-29.)
  - Apple's privacy rules mean Goalie only gets coded tokens for the picked apps, never their names, so the Locks screen shows counts ("3 apps, 1 category").
  - **Family Controls (Distribution) was approved** (reported 2026-10-29), so locks can be tested through TestFlight.
- **Launch plan (decided 2026-10-29): 1.0 ships without app locks and widgets**; they come in 1.1 right after. The reason: they're native Swift work tested only through cloud builds, and rushing them risked missing Nov 1.
- **Android:** no app locks at first (Android has no Screen Time equivalent; Play restricts AccessibilityService use). New personal Play accounts need a 14-day closed test with 12+ testers.

## Owner's to-do (accounts)
- Apple Developer Program (enrolling as an organization; the website for Apple's form will be a new domain, see below).
- Request the Family Controls distribution entitlement for bundle ID `com.thegoalieapp.goalie` (registered 2026-10-23; add-ons: `.monitor`, `.shield`, `.shieldaction`).
- Create the app in App Store Connect.
- Firebase project: Google and Apple sign-in, Firestore, iOS app, `GoogleService-Info.plist`.
- Domain **thegoalieapp.com** (e.g. from GoDaddy) for a **separate** website: home, About, Privacy Policy, Support.
  - Do **not** point the domain at the app's GitHub Pages site: changing the app's address would empty every installed home-screen copy, because web storage belongs to the address.

## App Store listing needs
Privacy policy URL, support URL, screenshots (6.7" and 6.5"), description, keywords, age rating, and a 1024×1024 icon. The logo is navy: three rounded bars (short, tall, medium), a line, then GOALIE. Source images are in `icons/`; regenerate at 1024.

## Updates after launch
- **Every update gets a verdict:** "Live update OK" (fixes, design and text tweaks, small improvements in the web layer) or "Send through App Store review" (anything native, payments, new personal data, big changes to what the app is, anything Apple might reject). Never use live updates to hide something from Apple.
- The web app's **Update now / Schedule for later** pop-up (date and time wheels) carries over: live updates use it as-is. App Store updates show a version that opens the App Store, and "Schedule for later" sets a reminder.
