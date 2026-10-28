# Goalie

A mobile-first Progressive Web App (PWA) for tracking goals: behaviors you want to do more of or cut back on. You install it on your iPhone home screen through Safari, so there's no App Store and no $99 developer fee.

## Features
- **Home**: colored goal cards in groups. Tap a card (or its +) to log; − (or ✗ for check-off goals) takes the last one back. Hold a card to log a custom amount on any date, undo/redo that goal's recent logging, edit its description, or delete it. The pencil (top right) turns on edit mode: drag cards to reorder or move them between groups, drag the group chips to reorder groups, tap × to delete. Filters: ALL, DAILY, WEEKLY, MONTHLY, YEARLY, DATE.
- **Create / Edit**: goal title, examples and non-examples, increase or decrease, a goal amount with a unit (occurrences, minutes, hours, $, ✓/✗ or your own) PER minute / hour / day / week / month / year or BY CUSTOM DATE, which weekdays are measured (logs on other days are kept but don't count), what one tap adds, groups, a daily reminder, colors, and what shows under the count. The preview is the real card.
- **By Custom Date goals** count everything logged until their date, then lock with ✓ reached or ✗ missed and offer to repeat with a new date.
- **Stats**: day / week / month / year as bar or line charts with the goal as a dashed line (running totals for weekly, monthly, yearly and by-date goals), averages per measured day, week, month or year. Tap a bar or point to see or edit that day.
- **To-Do**: sections, an Eisenhower priority list (Q1–Q4 → High / Medium / Low / No priority), undo/redo, and finished to-dos kept in Recently Deleted for 30 days.
- **Settings**: name, light / dark / auto appearance, week start, add-to or replace when logging custom dates, export / import backup (with a reminder every 2 weeks), reminder banners, Recently Deleted (goals and to-dos, 30 days), app updates, delete all data.
- Works offline. Data is stored on the device (localStorage plus IndexedDB, so it keeps saving as it grows).

## Run locally
```bash
npx http-server -p 5173 -c-1
```
Then open http://localhost:5173. (The offline service worker is skipped on localhost so edits show up right away.)

## Put it on your iPhone (free, via GitHub Pages)
1. Create a GitHub repo and upload every file in this folder (`index.html`, `styles.css`, `app.js`, `account.js`, `sw.js`, `vendor/`, `version.json`, `manifest.webmanifest`, `icons/`, `fonts/`).
2. In the repo, go to **Settings → Pages**, choose **Deploy from a branch**, pick `main` / root, and save.
3. After about a minute, open the `https://<username>.github.io/<repo>/` URL in **Safari** on your iPhone.
4. Tap **Share → Add to Home Screen**.

## Updating
When you change any app file, bump the version in **three** places:
1. `CACHE` in `sw.js` (e.g. `goalie-v89`)
2. `<meta name="goalie-version">` in `index.html`
3. `version` in `version.json` (must match the meta tag)

Installed copies never update on their own. The next time Goalie is opened it sees the newer `version.json` and asks: **Update now**, or schedule it (in an hour, tonight, tomorrow morning, or next time it's opened). Until then the offline copy keeps running the current version. Settings → **Update Goalie now** loads the newest version right away. Updates never touch your data.

## Limitations of a web app on iOS
- Reminders only fire while the app is open or was recently used. True background push needs a server.
- Reminder banners need iOS 16.4+, the app installed to the Home Screen, and permission (Settings → Turn on reminder banners).
- The home-screen icon is saved when Goalie is added to the Home Screen and doesn't change after that.
- There is no Apple Watch support. That needs a native app.
- Data lives on one device, and deleting the home-screen app deletes it. Use Export to back it up.

## Sign-in and sync (Firebase)
`account.js` adds Sign in with Apple / Google and syncs data through Firebase project `goalie-9522d`. Nothing loads until Settings is opened or someone is signed in. `vendor/firebase.js` is the Firebase SDK bundled into one file; to rebuild it, run `npm install` then `npm run build:firebase`.


