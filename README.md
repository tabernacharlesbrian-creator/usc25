# BayadQR - pure HTML + Firebase (no PHP, no MySQL)

## Setup (10 minutes)
1. https://console.firebase.google.com > Add project.
2. Build > **Firestore Database** > Create database (production mode).
3. Build > **Authentication** > Get started > Sign-in method > **Email/Password** > Enable. Then Users > **Add user** (your email + password). This is your login.
4. Firestore > **Rules** > paste `firestore.rules`, change `your-email@gmail.com` to the email you just added > Publish.
5. Project settings > Your apps > Web (</>) > copy the config into `firebase-config.js`.
6. Authentication > Settings > **Authorized domains**: add your site (e.g. usc25.infinityfreeapp.com or yourname.github.io).
7. Upload this whole folder to InfinityFree / GitHub Pages / Firebase Hosting. Open `index.html`.
8. Settings page: paste the Google Sheet link + Sheet Web app URL (deploy `sheet_script.gs`), and the Mail Web app URL + secret (deploy `mail_script.gs`).
9. Order: Sections > Students > Collections > Scan.

Firestore collections used: sections, students, events, payments (id = eventId_studentId), settings.
Google Sheet and Gmail calls now run in the browser, so the "Could not resolve host: script.google.com" error is gone.
Old MySQL data is not copied: re-add sections/students (QR codes are re-created as CICI-00001...).

## Python CRUD (optional admin tool)
`pip install firebase-admin`, put `serviceAccountKey.json` next to `firebase_crud.py`, then see the examples at the top of the file.
Never upload `serviceAccountKey.json` to your website or GitHub.

## GitHub Pages
Upload the CONTENTS of this folder (index.html must be at the top of the repo, not inside a subfolder) to
https://github.com/tabernacharlesbrian-creator/usc25 > Settings > Pages > Deploy from a branch > main > / (root).
Site: https://tabernacharlesbrian-creator.github.io/usc25/
Firebase > Authentication > Settings > Authorized domains > add `tabernacharlesbrian-creator.github.io`.
The `.gitignore` keeps serviceAccountKey.json out of GitHub. Never upload it.
