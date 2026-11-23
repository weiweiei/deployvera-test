const http = require('http');
const net = require('net');
const tls = require('tls');
const port = process.env.PORT || 3000;

// A stray error must never kill the checker: log it and keep serving.
process.on('uncaughtException', (e) => {
  console.error('uncaughtException (kept alive):', (e && e.stack) || e);
});

const HOSTING_WORDS = ['hosting', 'vpn', 'datacenter', 'data center',
  'colocation', 'colo', 'cloud', 'amazon', 'digitalocean', 'ovh', 'hetzner',
  'linode', 'vultr', 'contabo', 'm247', 'choopa', 'leaseweb', '3xk',
  'serverius', 'psychz', 'hostkey', 'aeza'];

function looksHosting(s) {
  s = (s || '').toLowerCase();
  return HOSTING_WORDS.some((w) => s.includes(w));
}

function maskUrl(u) {
  try {
    const rest = u.split('://', 2)[1].split('/', 1)[0];
    const dot = rest.indexOf('.');
    return 'https://' + rest.slice(0, 6) + '...' + rest.slice(dot);
  } catch (e) {
    return '<unparsable>';
  }
}

// GET targetUrl through one URnetwork HTTPS proxy URL (pure Node stdlib).
// Container has direct internet: TCP to the proxy, TLS to the proxy,
// CONNECT to the target, TLS to the target, then GET.
function requestViaProxy(proxyUrl, targetUrl, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs);
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    };
    const finish = (bodyBuf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const idx = bodyBuf.indexOf('\r\n\r\n');
      const body = idx >= 0 ? bodyBuf.slice(idx + 4) : bodyBuf;
      resolve(body.toString('utf8'));
    };
    const p = new URL(proxyUrl);
    const t = new URL(targetUrl);
    const sock = net.connect(p.port || 443, p.hostname);
    sock.once('error', fail);
    sock.once('connect', () => {
      const tls1 = tls.connect({ socket: sock, servername: p.hostname });
      tls1.once('error', fail);
      tls1.once('secureConnect', () => {
        if (t.protocol === 'https:') {
          let headBuf = Buffer.alloc(0);
          let headDone = false;
          const onData = (d) => {
            if (headDone) return;
            headBuf = Buffer.concat([headBuf, d]);
            const i = headBuf.indexOf('\r\n\r\n');
            if (i < 0) return;
            headDone = true;
            const head = headBuf.slice(0, i).toString('utf8');
            const status = (head.split('\r\n')[0] || '');
            tls1.removeListener('data', onData);
            if (!status.includes(' 200 ')) {
              tls1.destroy();
              return fail(new Error('proxy CONNECT refused: ' + status));
            }
            const tls2 = tls.connect({ socket: tls1, servername: t.hostname });
            tls2.once('error', fail);
            tls2.once('secureConnect', () => {
              const chunks = [];
              tls2.on('data', (c) => chunks.push(c));
              tls2.once('end', () => finish(Buffer.concat(chunks)));
              tls2.once('error', fail);
              tls2.write('GET ' + (t.pathname || '/') + (t.search || '') +
                ' HTTP/1.1\r\nHost: ' + t.hostname +
                '\r\nConnection: close\r\n\r\n');
            });
          };
          tls1.on('data', onData);
          tls1.write('CONNECT ' + t.hostname + ':' + (t.port || 443) +
            ' HTTP/1.1\r\nHost: ' + t.hostname + ':' + (t.port || 443) +
            '\r\n\r\n');
        } else {
          const chunks = [];
          tls1.on('data', (c) => chunks.push(c));
          tls1.once('end', () => finish(Buffer.concat(chunks)));
          tls1.write('GET ' + targetUrl + ' HTTP/1.1\r\nHost: ' + t.hostname +
            '\r\nConnection: close\r\n\r\n');
        }
      });
    });
  });
}

async function checkProxy(proxyUrl) {
  const first = JSON.parse(await requestViaProxy(proxyUrl, 'https://ipinfo.io/json'));
  const ip = first.ip;
  if (!ip) return { alive: false, ip: null, reason: 'proxy did not answer' };
  await new Promise((r) => setTimeout(r, 5000));
  let second = {};
  try {
    second = JSON.parse(await requestViaProxy(proxyUrl, 'https://ipinfo.io/json'));
  } catch (e) { /* keep first result */ }
  let api = {};
  try {
    api = JSON.parse(await requestViaProxy(proxyUrl,
      'http://ip-api.com/json/?fields=status,message,country,countryCode,' +
      'regionName,city,isp,org,as,proxy,hosting,query'));
  } catch (e) { /* ip-api optional */ }
  const stable = second.ip === ip;
  const country = (api.countryCode || first.country || '').toUpperCase();
  const isp = api.isp || first.org || '';
  const org = api.org || first.org || '';
  const hostingWord = looksHosting(org) || looksHosting(isp);
  const result = {
    alive: true, ip, stable, country,
    city: api.city || first.city,
    region: api.regionName,
    isp, org, as: api.as,
    proxy_flag: api.proxy, hosting_flag: api.hosting, hosting_word: hostingWord,
  };
  const reasons = [];
  if (country !== 'US') reasons.push('country is ' + (country || '?') + ', not US');
  if (api.proxy === true) reasons.push('ip-api proxy=true');
  if (api.hosting === true) reasons.push('ip-api hosting=true');
  if (hostingWord) reasons.push('org looks like hosting: ' + (org || isp));
  if (!stable) reasons.push('exit IP changed between checks (' + ip + ' -> ' + second.ip + ')');
  result.pass = reasons.length === 0;
  result.reason = reasons.length ? reasons.join('; ') : 'clean residential US exit';
  return result;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function safeJson(res, code, obj) {
  try {
    if (res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj, null, 2));
  } catch (e) { /* client already gone */ }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/ip') {
    try {
      const r = await fetch('https://ipinfo.io/json');
      const data = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('ip check failed: ' + e.message);
    }
    return;
  }

  if (req.url === '/check' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4096) req.destroy();
    });
    req.on('end', async () => {
      res.on('error', () => {});
      try {
        const body = JSON.parse(raw || '{}');
        const u = new URL(body.url || '');
        if (u.protocol !== 'https:' || !u.hostname.endsWith('.bringyour.com')) {
          safeJson(res, 400, { error: 'only https://*.bringyour.com proxy URLs' });
          return;
        }
        console.log('check', maskUrl(body.url));
        const result = await withTimeout(checkProxy(body.url), 75000, 'check timed out');
        console.log('check done', maskUrl(body.url), result.ip, result.pass);
        safeJson(res, 200, result);
      } catch (e) {
        console.log('check error', String((e && e.message) || e));
        safeJson(res, 500, { error: String((e && e.message) || e) });
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DeployVera test is running. Visit /ip to see the exit IP.\n');
});

server.listen(port, '0.0.0.0', () => {
  console.log('Listening on ' + port);
});
