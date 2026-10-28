# Mac session: Goalie on your iPhone and up to App Store Connect

Everything that could be done on Windows is already in the project: the Capacitor iPhone project (`ios/`), the app icon and launch screen, Sign in with Apple permission, iPhone-only portrait, and sign-in and sync. On the Mac you only install, build, run and upload.

## 1. Install (start Xcode first, it's huge)
1. **App Store → Xcode → Get.** Takes 30–60 minutes. When it finishes, open it once, agree to the license, and let it install the **iOS** platform.
2. **Node.js:** https://nodejs.org → download the **LTS** installer → run it.
3. **Claude:** install the Claude desktop app and sign in, so I can help on the Mac too.

## 2. Get the project
Open **Terminal** (⌘-Space, type Terminal) and run these one at a time:

```bash
git clone -b app-store https://github.com/thegoalieapp/goalie.git
cd goalie
npm install
npm run ios
```

`npm run ios` copies the app into the iPhone project and sets up the plugins (Google sign-in and the status bar; Facebook's SDK is switched off on purpose).

## 3. Open it in Xcode
```bash
npx cap open ios
```
In Xcode, the first time:
1. Wait for **"Resolving packages"** at the top to finish (a few minutes).
2. Left sidebar: click **App** (blue icon) → **TARGETS: App** → **Signing & Capabilities**.
3. Tick **Automatically manage signing** and choose your team under **Team**.
4. **Bundle Identifier** must say `com.thegoalieapp.goalie`. **Sign in with Apple** should already be listed.

## 4. Run it on your iPhone
1. Plug the iPhone into the Mac and unlock it. Tap **Trust** on the phone.
2. On the iPhone: **Settings → Privacy & Security → Developer Mode → On**, then restart when asked.
3. In Xcode's top bar, pick your iPhone as the destination and press **▶ Run**.
4. First time only: on the iPhone, **Settings → General → VPN & Device Management** → your developer name → **Trust**.

Then test: sign in with Apple, sign in with Google, add a goal, and confirm Settings says "Backed up and synced".

## 5. Upload the first build
1. Top bar destination: **Any iOS Device (arm64)**.
2. **Product → Archive.** When it finishes, the Organizer window opens.
3. **Distribute App → App Store Connect → Upload**, accepting the defaults.
4. About 15 minutes later it shows in App Store Connect → Goalie → **TestFlight**.

## If something goes wrong
Copy the red error text from Xcode (or take a photo) and send it to Claude.
