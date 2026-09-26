const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// Change this to your actual Railway URL!
const RAILWAY_URL = 'https://game-clipper-production.up.railway.app'; 
const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB

const GAMES_TO_UPLOAD = [
  { local: 'minecraft_small.mp4', remote: 'minecraft.mp4' },
  { local: 'fortnite_small.mp4', remote: 'fortnite.mp4' },
  { local: 'gtav_small.mp4', remote: 'gtav.mp4' },
  { local: 'roblox_small.mp4', remote: 'roblox.webm' } 
];

async function uploadFile(localName, remoteName) {
  const localPath = path.join(__dirname, 'storage', 'gameplay', localName);
  
  if (!fs.existsSync(localPath)) {
    console.error(`❌ Skipping ${localName}: File not found yet (maybe still compressing?)`);
    return;
  }

  const stat = fs.statSync(localPath);
  const totalSize = stat.size;
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

  console.log(`\n🚀 Starting upload of ${localName} as ${remoteName} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
  
  let append = false;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize) - 1;
    const chunkSize = end - start + 1;

    console.log(`➡️ Chunk ${i + 1}/${totalChunks}...`);

    await new Promise((resolve, reject) => {
      const url = new URL(`${RAILWAY_URL}/api/upload-stream?name=${remoteName}&append=${append}`);
      const client = url.protocol === 'https:' ? https : http;

      const options = {
        method: 'POST',
        headers: {
          'Content-Length': chunkSize,
          'Content-Type': 'application/octet-stream',
        }
      };

      const req = client.request(url, options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            console.error(`❌ Chunk Failed! Status: ${res.statusCode} Body: ${body}`);
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      fs.createReadStream(localPath, { start, end }).pipe(req);
    });

    append = true; 
  }
  console.log(`✅ Uploaded ${remoteName} successfully!`);
}

async function uploadAll() {
  for (const game of GAMES_TO_UPLOAD) {
    await uploadFile(game.local, game.remote);
  }
  console.log(`\n🎉 All games uploaded to Railway successfully!`);
}

uploadAll().catch(console.error);
