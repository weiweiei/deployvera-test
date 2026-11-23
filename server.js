const http = require('http');
const port = process.env.PORT || 3000;

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
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DeployVera test is running. Visit /ip to see the exit IP.\n');
});

server.listen(port, '0.0.0.0', () => {
  console.log('Listening on ' + port);
});
