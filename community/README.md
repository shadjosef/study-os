# Study-OS community

The website and encrypted library run on GitHub Pages. Community profiles, the leaderboard and direct messages use a small Cloudflare Worker backed by D1. The Community tab appears when the website has an HTTPS endpoint in `site-pack/community.json`.

Members use a nickname and a personal profile key. Share totals explicitly to appear on the leaderboard, and use **Hide my totals** to leave it. Rankings use the totals submitted by each device and serve as a study comparison rather than an exam score. The API stores the chosen nickname, aggregate totals and messages. It verifies each sender's profile and returns messages only to their sender or recipient. Members can block or unblock other profiles.

## Deploy the community

1. Run `npx wrangler login` and then `npx wrangler d1 create study-os-community`.
2. Copy `wrangler.example.json` to `wrangler.json` in this directory and enter the database ID. Run `npx wrangler d1 execute study-os-community --remote --file schema.sql`.
3. Run `npx wrangler deploy`. Set the `JOIN_PROOF` secret to the SHA-256 hex digest of the current access string, with its trailing newline removed. Pipe the digest to Wrangler directly. Use the absolute path to the private key file.

   ```sh
   python3 -c 'from pathlib import Path; import hashlib,sys; print(hashlib.sha256(Path(sys.argv[1]).read_text().strip().encode()).hexdigest())' /path/to/private-access-string.txt | npx wrangler secret put JOIN_PROOF
   ```

4. Save `{"api":"https://study-os-community.YOUR-SUBDOMAIN.workers.dev"}` in `site-pack/community.json` and push it. GitHub Pages adds the Community tab to its next build.

When rotating the member access string, update this digest too. Existing personal profile keys retain access to their own stats and messages.
