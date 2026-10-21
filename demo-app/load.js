// Sends steady traffic so metrics and logs move during the demo.
// Usage: node load.js https://my-app.liara.run [requestsPerSecond] [seconds]
const [, , base = 'http://localhost:3000', rps = '5', seconds = '60'] = process.argv;
const paths = ['/', '/products', '/health'];
let sent = 0;
let failed = 0;

const timer = setInterval(() => {
  for (let i = 0; i < Number(rps); i++) {
    const path = paths[sent % paths.length];
    sent++;
    fetch(base + path)
      .then((r) => { if (r.status >= 500) failed++; })
      .catch(() => failed++);
  }
}, 1000);

setTimeout(() => {
  clearInterval(timer);
  console.log(`sent=${sent} failed=${failed}`);
}, Number(seconds) * 1000);
