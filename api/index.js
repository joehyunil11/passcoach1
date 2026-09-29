/* Vercel이 모든 요청을 Node 서버(server.js)로 넘깁니다. */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function keepDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) keepDir(full);
    else fs.readFileSync(full);
  }
}

keepDir(path.join(root, 'css'));
keepDir(path.join(root, 'js'));
keepDir(path.join(root, 'img'));
for (const name of fs.readdirSync(root)) {
  if (name.endsWith('.html')) fs.readFileSync(path.join(root, name));
}

module.exports = require('../server');
