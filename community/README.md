# Study-OS community

The website and encrypted library run on GitHub Pages. Community profiles, the leaderboard and direct messages use a small Cloudflare Worker backed by D1. The Community tab appears when the website has an HTTPS endpoint in `site-pack/community.json`.

Join with a Community invite code and use a nickname and a personal profile key. Every profile appears on the members-only leaderboard, with hours, completed questions, attempts, practice accuracy and the current Study-OS timer. Stats are submitted from the browser with the most recorded attempts. Solo practice works without a profile.

The leaderboard, global chat and direct messages open during timed breaks and from 20:00 to midnight Europe/Oslo. Timer status updates once a minute while active and expires after less than two minutes without an update. The status comes from the browser timer. Direct messages are visible to their participants in the app. Chat is shared with all Community members, displays posts from the last seven days, and supports blocking members. Members can delete their profile and messages from the active database. Review your privacy notice, contact details and Cloudflare terms with the operator before inviting students.

Use the [Study-OS MCP tool](../docs/study-sets-mcp.md) to create a study set link. During break access, members can share a set after opening that link, save copies of shared sets, or remove a set they published. Practice from custom sets stays outside the leaderboard and Elo.

## Deploy the community

1. Run `npx wrangler login` and then `npx wrangler d1 create study-os-community --jurisdiction eu`.
2. Copy `wrangler.example.json` to `wrangler.json` in this directory and enter the database ID. Run `npx wrangler d1 execute study-os-community --remote --file schema.sql`.
3. Generate a Community invite code with the prefix `soci1_` followed by `secrets.token_urlsafe(32)` from Python. Save it in a private file outside Git. This code grants access to Community registration. Course library access uses a separate key. Run `npx wrangler deploy` and pipe the SHA-256 digest of the invite code to the Worker's `JOIN_PROOF` secret.

   ```sh
   python3 -c 'from pathlib import Path; import hashlib,sys; print(hashlib.sha256(Path(sys.argv[1]).read_text().strip().encode()).hexdigest())' /path/to/private-community-invite.txt | npx wrangler secret put JOIN_PROOF
   ```

4. Save `{"api":"https://study-os-community.YOUR-SUBDOMAIN.workers.dev"}` in `site-pack/community.json` and push it. GitHub Pages adds the Community tab to its next build.

To rotate the Community invite code, update its digest. Existing personal profile keys retain access to their own stats and messages.
