require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');

const requiredEnv = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'];
for (const name of requiredEnv) {
  if (!process.env[name] || /^(put_|replace_)/.test(process.env[name])) throw new Error(`Set ${name} in your .env file.`);
}
if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
const configText = fs.readFileSync(path.join(__dirname, 'access-rules.json'), 'utf8').replace(/^\uFEFF/, '');
const config = JSON.parse(configText);
const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const redirectUri = `${baseUrl}/auth/discord/callback`;
const production = process.env.NODE_ENV === 'production';
if (production) app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  name: 'tjo.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

async function getGuildMember(guildId, token, retries = 2) {
  const response = await fetch(`https://discord.com/api/v10/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 404) return null;
  if (response.status === 401) throw new Error('Discord sign-in expired. Please sign in again.');
  if (response.status === 429) {
    const details = await response.json().catch(() => ({}));
    const retryAfter = Number(details.retry_after || response.headers.get('retry-after') || 1);
    if (retries > 0 && retryAfter <= 15) {
      await new Promise(resolve => setTimeout(resolve, Math.ceil(retryAfter * 1000)));
      return getGuildMember(guildId, token, retries - 1);
    }
    throw new Error(`Discord is rate limiting membership checks. Try again in ${Math.ceil(retryAfter)} seconds.`);
  }
  if (!response.ok) throw new Error(`Discord membership check failed (${response.status}).`);
  return response.json();
}

app.get('/auth/discord', (req, res, next) => {
  req.session.oauthState = crypto.randomBytes(24).toString('hex');
  req.session.save(error => {
    if (error) return next(error);
    const query = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID, redirect_uri: redirectUri,
      response_type: 'code', scope: 'identify guilds.members.read', state: req.session.oauthState
    });
    res.redirect(`https://discord.com/oauth2/authorize?${query}`);
  });
});

app.get('/auth/discord/callback', async (req, res, next) => {
  try {
    if (req.query.error) return res.redirect('/?login=cancelled');
    if (!req.query.code || req.query.state !== req.session.oauthState) return res.status(400).send('Discord sign-in could not be verified. Return to the page and try again.');
    delete req.session.oauthState;
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error('Discord token exchange failed. Check the app credentials and redirect URL.');
    const userResponse = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!userResponse.ok) throw new Error('Could not read the Discord profile. Please try again.');
    const user = await userResponse.json();
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.user = { id: user.id, username: user.global_name || user.username };
      req.session.accessToken = token.access_token;
      req.session.expiresAt = Date.now() + token.expires_in * 1000;
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      req.session.save(saveError => saveError ? next(saveError) : res.redirect('/'));
    });
  } catch (error) { next(error); }
});

app.get('/api/me', async (req, res, next) => {
  if (!req.session.user || !req.session.accessToken) return res.status(401).json({ signedIn: false });
  if (Date.now() >= req.session.expiresAt) {
    return req.session.destroy(() => res.status(401).json({ signedIn: false, message: 'Your Discord session expired. Please sign in again.' }));
  }
  try {
    const roles = {};
    for (const id of config.guildIds) {
      const member = await getGuildMember(id, req.session.accessToken);
      roles[id] = member ? member.roles || [] : null;
    }
    const allowed = access => access === 'everyone' || (access?.any || []).some(rule => {
      const memberRoles = roles[rule.guildId];
      return memberRoles !== null && memberRoles !== undefined && (!rule.roleIds || rule.roleIds.some(id => memberRoles.includes(id)));
    });
    res.json({ signedIn: true, user: req.session.user, csrfToken: req.session.csrfToken,
      links: config.links.filter(link => allowed(link.access)).map(({ id, title, description, url }) => ({ id, title, description, url })) });
  } catch (error) { next(error); }
});

app.post('/auth/logout', (req, res) => {
  if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) return res.sendStatus(403);
  req.session.destroy(error => {
    if (error) return res.sendStatus(500);
    res.clearCookie('tjo.sid', { httpOnly: true, sameSite: 'lax', secure: production });
    res.sendStatus(204);
  });
});

app.use((error, req, res, next) => {
  console.error(error.message);
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/api/')) {
    const signedIn = Boolean(req.session.user && req.session.accessToken);
    const links = signedIn ? config.links
      .filter(link => link.access === 'everyone')
      .map(({ id, title, description, url }) => ({ id, title, description, url })) : [];
    return res.status(502).json({ signedIn, user: signedIn ? req.session.user : null,
      csrfToken: signedIn ? req.session.csrfToken : null, links, message: error.message || 'Access check failed.' });
  }
  res.status(500).send('The site could not complete the request. Check the local server output.');
});
app.listen(port, () => console.log(`TJO Access Hub running at ${baseUrl}`));
