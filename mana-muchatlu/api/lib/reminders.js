/** Private reminder policy. No journal text is ever used in a push payload. */
const crypto = require('crypto');
const TIME_ZONE = 'Asia/Kolkata';
const SCHEDULE = { time: '21:30', timeZone: TIME_ZONE };
const IST_OFFSET = 330 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const MESSAGES = [
  'nuvvu nee paithyam… edo okati raya {ending} 😌',
  'It’s journal time ♥ Oka chinna note raaddama?',
  'Oye {nickname}, eroju muchatlu pending 😏',
  'Nee brain lo open unna tabs konni ikkada close cheyyi {ending} 🫶',
  'Perfect words avasaram ledu. Nee words chaalu ♥',
  'Eroju plot twist enti? Cheppu {ending} 👀',
  'Phone scroll ayindi. Ippudu konchem mana muchatlu? 😌',
  'Oka line aina raayi {ending}… attendance vesedham ♥',
  'Dear diary anaku. Oye bujji ani start chesey 😏',
  'Eroju em jarigindi {nickname}? Mana page wait chesthundi 🫶',
  'Overthinking ki oka chair icchi, journal open cheyyi {ending} 😌',
  'Tea ayipoyinda? Ippudu konchem muchatlu ☕♥',
  'Nee daily episode recap ekkada {ending}? 👀',
  'Chinna gnapakam aina okay. Raasi pettesey ♥',
  'Ee roju nee mood ki oka title pettu {ending} 😌',
  'Journal ki ghost cheyyaku {nickname} 👻♥',
  'Oka cute moment, oka complaint… nee ishtam {ending} 😏',
  'Eroju highlight enti? Lowlight aina parledhu 🫶',
  'Mana safe space lo nee seat reserve chesi undi ♥',
  'Nidra mundu oka chinna brain dump cheddama? 😌',
  'Drama unte raayi. Drama lekapothe adi kuda raayi {ending} 😏',
  'Eroju manam ela unnam? Oka note lo cheppava ♥',
  'Oye, nee thoughts ki storage ikkade {ending} 🫶',
  'Journal open cheyyi. Shakespeare avvalsina pani ledu 😌',
  'Rendu nimishalu chaalu {nickname}. Oka gnapakam save cheddam ♥',
  'Eroju navvinchina vishayam okati cheppu {ending} 😊',
  '9:30 ayindi. Mana muchatlu shift start 😏',
  'Mana page blank ga undi… nee entry kosam ♥',
  'Eroju nee manasu em antundi {ending}? 🫶',
  'Oka thought, oka photo, oka voice note… edo okati 😌',
  'Nuvvu raasthe chaalu. Grammar ni repu chooddam 😏',
  'Eroju em feel ayyavo, ade raayi {nickname} ♥',
  'Daily gossip committee ki nee report kavali {ending} 👀',
  'Ee rojuni repatiki marchipokunda oka note? 🫶',
  'Oye {nickname}, journal tho konchem muchatlu cheyyi 😌',
  'Mana little world ki ee roju update ivvava ♥',
  'Big day aina boring day aina… page ready {ending} 😏',
  'Nee thoughts ki judgement ledu. Oka entry chaalu 🫶',
  'Konchem paithyam, konchem prema… raayi {ending} ♥',
  'Eroju emaina funny ga jariginda? Spill cheyyi 😏',
  'Nee future self ki ee roju nunchi oka chinna letter ♥',
  'Scroll ki interval. Mana muchatlu ki time {ending} 😌',
  'Oka chinna thank-you moment raaddama? 🫶',
  'Eroju hero nuvve. Recap kuda nuvve raayi {ending} 😏',
  'Ala anipinchinda? Ila jariginda? Ikkada cheppey ♥',
  'Mana gnapakala collection ki inkoka chinna addition? 🫶',
  'No pressure {nickname}… oka line tho start cheyyi 😌',
  'Eroju nee favourite five seconds enti {ending}? ♥',
  'Journal time. Nee inner narrator ni piluvu 😏',
  'Manasulo pettukoku. Mana page lo pettesey {ending} 🫶',
  'Ee roju story ki end credits raaddama? 😌',
  'Oye {nickname}, nee muchatlu miss avthunnayi ♥',
  'Eroju em baaga jarigindi? Chinna win aina celebrate cheddam 🫶',
  'Journal lo entry ivvu {ending}. VIP nuvve 😏',
  'Nidra ki mundu mana rojuki oka bookmark peddama? ♥',
  'Nee random thought kuda mana gnapakame {ending} 😌',
  'Eroju paithyam quota entha {nickname}? Cheppey 😏',
  'Mana space. Nee pace. Oka chinna note? 🫶',
  'Love you. Ippudu konchem journal kuda raayi {ending} ♥',
  'Ee rojuni oka line lo daacheddama {nickname}? 😌',
];

function identity(member) {
  const words = [member?.id, member?.name].join(' ').toLowerCase().split(/[^a-z]+/);
  return words.some(w => ['shivani', 'bujjuluu', 'bujji'].includes(w)) ? 'shivani' : 'prakyath';
}
function dayNumber(time) { return Math.floor((new Date(time).getTime() + IST_OFFSET) / DAY); }
function localDate(time) { return new Date(dayNumber(time) * DAY).toISOString().slice(0, 10); }
function reminder(member, time) {
  const index = ((dayNumber(time) % MESSAGES.length) + MESSAGES.length) % MESSAGES.length;
  const wife = identity(member) === 'shivani';
  return { title: 'Mana Muchatlu ♥',
    body: MESSAGES[index].replaceAll('{ending}', wife ? 've' : 'ra').replaceAll('{nickname}', wife ? 'bujji' : 'bangaaramm'),
    tag: 'mana-reminder-' + localDate(time), url: '/', kind: 'journal-reminder' };
}
function partition(coupleId) { return 'REMINDERS#' + coupleId; }
function deviceKey(endpoint) { return 'DEVICE#' + crypto.createHash('sha256').update(endpoint).digest('hex'); }
function validateEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    const trusted = url.hostname.endsWith('.push.apple.com') ||
      ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname);
    return trusted && url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash && url.pathname.length > 1;
  } catch (_) { return false; }
}
function decodeKey(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes ? decoded : null;
}
function validateSubscription(value) {
  if (!validateEndpoint(value?.endpoint)) return { ok: false, error: 'unsupported push subscription endpoint' };
  const publicKey = decodeKey(value.keys?.p256dh, 65);
  const auth = decodeKey(value.keys?.auth, 16);
  if (!publicKey || !auth || publicKey[0] !== 4) return { ok: false, error: 'invalid push subscription keys' };
  try { crypto.ECDH.convertKey(publicKey, 'prime256v1'); }
  catch (_) { return { ok: false, error: 'invalid push subscription public key' }; }
  return { ok: true, value: { endpoint: value.endpoint,
    keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') } } };
}
/** HKDF domain separation keeps VAPID stable without replacing existing secrets.
 * The derived private key is never sent to the browser, saved in git or logged.
 * Rotating SESSION_SECRET deliberately requires devices to re-enable reminders.
 */
function vapidKeys(secret, coupleId, origin) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('a strong session secret is required for reminders');
  for (let attempt = 0; attempt < 16; attempt++) {
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret),
      Buffer.from('mana-muchatlu/web-push/v1'), Buffer.from(coupleId + ':' + origin + ':' + attempt), 32));
    const ecdh = crypto.createECDH('prime256v1');
    try {
      ecdh.setPrivateKey(key);
      return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: key.toString('base64url') };
    } catch (_) { /* An out-of-range P-256 scalar: derive another candidate. */ }
  }
  throw new Error('could not derive VAPID keys');
}
function scheduledTime(event, now) {
  const time = new Date(event?.time).getTime();
  const local = new Date(time + IST_OFFSET);
  if (!Number.isFinite(time) || local.getUTCHours() !== 21 || local.getUTCMinutes() !== 30 ||
      time > now + 60000 || now - time > 15 * 60000) return null;
  return time;
}
module.exports = { MESSAGES, SCHEDULE, TIME_ZONE, dayNumber, localDate, reminder,
  partition, deviceKey, validateEndpoint, validateSubscription, vapidKeys, scheduledTime };
