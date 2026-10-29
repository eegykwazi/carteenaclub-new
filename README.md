# CARTEENACLUB — Fresh Upload Project

This is a separate project package assembled for the new CARTEENACLUB upload. It does not overwrite the existing GitHub repository or Render deployment.

## Included
- `public/index.html` — the exact homepage HTML from the homepage package you confirmed. Its visual design and layout have been preserved.
- `public/admin-gift-manager.html` — the Admin Gift Manager interface.
- `server/server.js` — the Express API/backend from the connected-admin-update package, including gift catalogue/admin gift management routes, account APIs, coin/payment foundations, and other documented MVP routes.
- `package.json`, `.env.example`, `.gitignore` — project configuration.

## Run locally
Requirements: Node.js 20+ and npm.

1. Extract this ZIP into a new folder.
2. Open a terminal in that folder and run `npm install`.
3. Copy `.env.example` to `.env` and set a strong unique `JWT_SECRET` (at least 32 characters). Configure `ADMIN_EMAIL` carefully. Keep `.env` private.
4. Run `npm start`.
5. Open `http://localhost:3000` for the homepage.
6. Open `http://localhost:3000/admin-gift-manager.html` for the gift manager.
7. Check `http://localhost:3000/api/health` for the API health response.

## Important notes before public launch
- The homepage file is preserved as the approved visual preview. Its gift-send, login, follow, comment, wallet and LIVE interactions still include preview-only behavior and are not all wired to backend endpoints yet. The presence of an API does not mean these homepage buttons are integrated.
- The Admin Gift Manager uses authenticated admin endpoints; configure and test admin provisioning before use. Do not expose it publicly until authorization and the first-admin setup are reviewed.
- This is not yet a production-ready social platform. Real livestreaming, private LIVE access control, complete user-to-user gift transfers, card/Google Pay checkout, full email verification and production security review remain future work.
- SQLite and uploaded files are stored under `DATA_DIR` (default `./data`). Use persistent disk storage on the eventual host or data can be lost.
- Never commit `.env` or secrets to GitHub.

## Separate deployment
Create a new GitHub repository for this folder (for example `carteenaclub-new`) and deploy it separately. Do not upload it into the existing `carteenaclub` repository if your intention is to keep that project untouched.
