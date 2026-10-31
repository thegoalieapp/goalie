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
- Bundle ID `com.thegoalieapp.goalie`. Add-ons for app locks: `.monitor`, `.shield`, `.shieldaction`. Family Controls (Distribution) is approved and ticked on all four IDs (2026-10-30), with the App Group `group.com.thegoalieapp.goalie`. Build 9 (Oct 30) was the first TestFlight build with app locks.
- App Store Connect: "Goalie: Goal & Habit Tracker", SKU goalie-001. The API key is stored as GitHub secrets (`APPSTORE_ISSUER_ID`, `APPSTORE_KEY_ID`, `APPSTORE_P8`).
- Website: https://thegoalieapp.com (repo `thegoalieapp/goalie-site`), with privacy.html and support.html.
- The iOS plugin config turns **off** the Facebook SDK (privacy policy: no third-party tracking). Keep it off.

## Building the app
The borrowed Mac didn't have room for Xcode, so builds run in the cloud: `.github/workflows/testflight.yml` builds on GitHub's macOS 15 runner (Xcode 26.3; macOS 26 runners were too busy) on every push to `app-store` and uploads to TestFlight. Signing is manual (Family Controls Distribution only goes into hand-made profiles): the Apple Distribution certificate is in the `DIST_P12`/`DIST_P12_PASSWORD` secrets (its key and files are in the owner's `Documents\Goalie signing` folder, never in the repo), and the four portal profiles ("Goalie App Store", "Goalie Monitor App Store", "Goalie Shield App Store", "Goalie Shield Action App Store") are downloaded by name. Changing an App ID's capabilities makes its profiles Invalid: regenerate them in the portal. The owner tests through the TestFlight app. `docs/MAC-SESSION.md` is the fallback if a Mac becomes available.

## Status (2026-10-30)
- Build 12 (TestFlight) is the 1.0 submission build: sign-in and sync, app locks, screen-time limits (Settings → App Locks · Screen Time; they always lock at the limit and also show as a goal card), real reminders, iPad layout, Customizable App Features.
- Screen Time minutes (entries with auto: true) never sync to the cloud: account.js keeps them, and deleted limits' minutes, out of the cloud copy. Keep it that way (privacy policy and Apple's Screen Time rules).
- App locks: locks.js, ios/App/App/GoalieLocks/, and the helpers in ios/App/GoalieMonitor, GoalieShield and GoalieShieldAction, added to the Xcode project by tools/add-lock-targets.rb (the cloud build runs it).
- The App Store listing text, privacy answers and review notes are on a Claude artifact page; screenshots are in the owner's DocumentsGoalie App Store screenshots.
- Still to do after launch: widgets.
