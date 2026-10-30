// Talks to the App Store Connect API with the build's API key (used by the cloud build).
//   node tools/app-store-connect.js check                  → "200" when Apple accepts the key, else the status and Apple's reason
//   node tools/app-store-connect.js profiles DIR NAME...   → saves each named signing profile into DIR
// The key comes from the environment: KEY_FILE (the .p8), KEY_ID and ISSUER_ID.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function token() {
  const b64 = x => Buffer.from(x).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'ES256', kid: process.env.KEY_ID, typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: process.env.ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: fs.readFileSync(process.env.KEY_FILE), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64(sig)}`;
}

async function api(route) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${route}`, { headers: { Authorization: `Bearer ${token()}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const reasons = body => JSON.stringify((body.errors || []).map(e => `${e.title}: ${e.detail}`));

(async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'check') {
    const { status, body } = await api('/v1/apps?filter[bundleId]=com.thegoalieapp.goalie');
    console.log(status, status === 200 ? '' : reasons(body));
  } else if (command === 'profiles') {
    const [dir, ...names] = args;
    fs.mkdirSync(dir, { recursive: true });
    for (const name of names) {
      const { status, body } = await api(`/v1/profiles?filter[name]=${encodeURIComponent(name)}&filter[profileState]=ACTIVE&fields[profiles]=name,uuid,profileContent`);
      const profile = (body.data || []).find(p => p.attributes.name === name);
      if (!profile) {
        console.log(`::error::No active signing profile named "${name}" in the developer portal (${status} ${status === 200 ? '' : reasons(body)})`);
        process.exitCode = 1;
        continue;
      }
      fs.writeFileSync(path.join(dir, `${profile.attributes.uuid}.mobileprovision`), Buffer.from(profile.attributes.profileContent, 'base64'));
      console.log(`Installed signing profile "${name}"`);
    }
  } else {
    console.log('Usage: check | profiles DIR NAME...');
    process.exitCode = 2;
  }
})().catch(err => { console.log(`0 ${err.message}`); process.exitCode = 1; });
