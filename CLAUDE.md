# Goalie: notes for Claude

Goalie is Tanner Witte's goal and habit tracker: a vanilla JS web app (`index.html`, `styles.css`, `app.js`, `account.js`, `sw.js`) that is also being wrapped with Capacitor for the App Store. The target is **live by Nov 1, 2026**. The full plan is in `docs/APP-STORE-PLAN.md`, and the Mac steps are in `docs/MAC-SESSION.md`.

## Rules the owner set
- **Never push without being told to.** Make the change, test it, report it, and wait for "push". Local commits are fine.
- **Branches:** the live web app is GitHub Pages on remote `main` (https://thegoalieapp.github.io/goalie/, still at v88). The App Store work (sign-in and sync, `ios/`, iPad layout, vision fixes) lives on remote **`app-store`**. Don't merge it into `main` unless the owner decides sign-in should go live on the web too.
- **When pushing a web release:** bump the version in 3 places (`sw.js` CACHE, the `goalie-version` meta in `index.html`, `version.json`), then check that the live site serves the new version.
- **Every update gets a verdict:** "✅ Live update OK" (web-layer fixes and tweaks) or "🍎 Send through App Store review" (native changes, new data, anything Apple reviews).
- Never auto-update installed copies. The app asks "Update now / Schedule for later".
- Ask before inventing design details the owner didn't specify.

## Setup
- Firebase project `goalie-9522d`: Google and Apple sign-in (Services ID `com.thegoalieapp.goalie.signin`), Firestore (`nam5`) with per-user rules (`users/{uid}/**`). Web sign-in, sync and Delete account were tested on 2026-10-27.
- Bundle ID `com.thegoalieapp.goalie`. Add-ons for app locks: `.monitor`, `.shield`, `.shieldaction`. Family Controls (Distribution) has been requested from Apple.
- App Store Connect: "Goalie: Goal & Habit Tracker", SKU goalie-001. The API key is stored as GitHub secrets (`APPSTORE_ISSUER_ID`, `APPSTORE_KEY_ID`, `APPSTORE_P8`).
- Website: https://thegoalieapp.com (repo `thegoalieapp/goalie-site`), with privacy.html and support.html.
- The iOS plugin config turns **off** the Facebook SDK (privacy policy: no third-party tracking). Keep it off.

## Building the app
The borrowed Mac didn't have room for Xcode, so builds run in the cloud: `.github/workflows/testflight.yml` builds on GitHub's macOS 15 runner (Xcode 26.3; macOS 26 runners were too busy) on every push to `app-store` and uploads to TestFlight with cloud-managed signing. The owner tests through the TestFlight app. `docs/MAC-SESSION.md` is the fallback if a Mac becomes available.

## Next steps
1. Get the first TestFlight build through (check the Actions log, especially the entitlements step: Sign in with Apple must be listed).
2. Test Sign in with Apple and Google natively, plus sync.
3. App locks are built (locks.js, ios/App/App/GoalieLocks/, the three helpers in ios/App/GoalieMonitor, GoalieShield and GoalieShieldAction). The helpers are added to the Xcode project by `tools/add-lock-targets.rb`, which the cloud build runs; run it on a Mac too before opening Xcode. Needs the App Group `group.com.thegoalieapp.goalie` on all four IDs.
4. Still to build: widgets, and store materials (screenshots for iPhone **and iPad**, description, privacy answers). The owner chose to ship 1.0 with app locks included (one submission).
