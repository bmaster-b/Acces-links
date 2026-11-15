# TJO Access Hub

Discord OAuth2 link hub with server and role based link visibility. It does not use a bot.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`. Set `DISCORD_CLIENT_SECRET` from the Discord Developer Portal and replace `SESSION_SECRET` with a random string at least 32 characters long. Do not commit or share `.env`.
3. In the Developer Portal for application `1571567789401964564`, add `http://localhost:3000/auth/discord/callback` under OAuth2 Redirects.
4. Open PowerShell in this folder and run:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   npm.cmd install
   npm.cmd start
   ```

5. Open http://localhost:3000 and choose **Log in with Discord**. Approve the `identify` and `guilds.members.read` access requested by Discord.

The backend checks each listed server through Discord's current-user guild-member OAuth endpoint. A server the user is not in, or a role they do not have, will not unlock the corresponding link.

## Add links or access rules

Edit `access-rules.json`. Replace placeholder `url` values with the real links. Use `"access": "everyone"` for a link available to every signed-in user. Otherwise, use `"any"` with one or more membership rules:

```json
{ "any": [{ "guildId": "SERVER_ID", "roleIds": ["ROLE_ID"] }] }
```

Omit `roleIds` to require only membership in that server. Add server IDs to `guildIds` when you add a new server rule.

## GitHub and public hosting

GitHub can store the project, but GitHub Pages cannot run its Node backend. Deploy the app to a Node-capable host, set the environment variables from `.env.example` in the host dashboard, set `BASE_URL` to the public HTTPS address, and register that address plus `/auth/discord/callback` as an OAuth redirect. The starter uses Express's in-memory session store, which is suitable only for local testing; before publishing, configure a persistent session store supported by your host.
