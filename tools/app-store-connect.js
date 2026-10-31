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
    const { status, body } = await api('/v1/profiles?limit=200&fields[profiles]=name,uuid,profileState,profileContent');
    if (status !== 200) { console.log(`::error::Couldn't list the signing profiles (${status} ${reasons(body)})`); process.exitCode = 1; return; }
    const all = body.data || [];
    for (const name of names) {
      const matches = all.filter(p => p.attributes.name.trim().toLowerCase() === name.toLowerCase());
      const profile = matches.find(p => p.attributes.profileState === 'ACTIVE');
      if (!profile) {
        console.log(matches.length
          ? `::error::Signing profile "${name}" is ${matches.map(p => p.attributes.profileState).join(', ')}, not active: open it in the developer portal → Edit → Generate`
          : `::error::No signing profile named "${name}". The profiles the build can see: ${all.map(p => `"${p.attributes.name}" (${p.attributes.profileState})`).join(', ') || 'none'}`);
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
