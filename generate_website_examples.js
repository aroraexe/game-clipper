const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// Initialize environment
require('dotenv').config();

const { initStorage } = require('./backend/utils/storage.util');
const jobStore = require('./backend/jobs/jobStore');
const { enqueue } = require('./backend/jobs/renderQueue');

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  await initStorage();

  const jobs = [
    {
      story: "I found this weird village where all the villagers walked backward. When I tried trading with them, the game crashed. I logged back in, and my entire base was upside down. The scariest part? The chat said 'welcome home' in red text.",
      gameplayId: "minecraft",
      captionStyle: "bold-yellow",
      voice: "narrator",
      duration: 30
    },
    {
      story: "I was just doing a normal stunt jump off Mt. Chiliad, but halfway in the air, the gravity just gave out. My car kept floating up, past the clouds, past the skybox. Then my screen went black and I heard someone knocking on my actual bedroom window.",
      gameplayId: "gtav",
      captionStyle: "word-pop",
      voice: "calm",
      duration: 30
    },
    {
      story: "I joined an empty obby server at 2 AM. Every time I failed a jump, the respawn point got closer to a dark door. I didn't want to know what was behind it, but my character started walking toward it on its own.",
      gameplayId: "roblox",
      captionStyle: "clean",
      voice: "default",
      duration: 30
    },
    {
      story: "It was the final circle, 1v1. I had the high ground. I fired a shot, but the other player didn't build or shoot back. They just stood there and started doing the default dance. Suddenly my entire screen filled with victory royales before I even got the elim.",
      gameplayId: "fortnite",
      captionStyle: "white-highlight",
      voice: "energetic",
      duration: 30
    }
  ];

  const jobIds = [];

  for (let i = 0; i < jobs.length; i++) {
    const jobData = jobs[i];
    const jobId = uuidv4();
    // Default values mimicking controller logic
    const job = jobStore.create(jobId, {
      story: jobData.story,
      gameplayId: jobData.gameplayId,
      captionStyle: jobData.captionStyle,
      captionColor: '#ffffff',
      voice: jobData.voice,
      duration: jobData.duration
    });
    enqueue(jobId);
    jobIds.push(jobId);
    console.log(`Enqueued job ${jobId} for ${jobData.gameplayId} with style ${jobData.captionStyle}`);
    await wait(2000);
  }

  // Poll until all are done
  let allDone = false;
  while (!allDone) {
    allDone = true;
    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i];
      const job = jobStore.get(jobId);
      if (!job) {
         console.log(`Job ${jobId} not found!`);
         continue;
      }
      if (job.status === 'failed') {
        console.error(`Job ${jobId} failed: ${job.error}`);
      } else if (job.status !== 'completed') {
        allDone = false;
        console.log(`Job ${jobId} is ${job.status} (${job.stage}) - ${job.progress}%`);
      } else {
        console.log(`Job ${jobId} completed! File at ${job.outputPath}`);
      }
    }
    if (!allDone) await wait(10000); // Check every 10 seconds
  }
  
  console.log("All done!");
  // Copy them to frontend
  for (let i = 0; i < jobIds.length; i++) {
    const job = jobStore.get(jobIds[i]);
    if (job && job.status === 'completed') {
      const dest = path.join(__dirname, 'frontend', `example_${i+1}.mp4`);
      fs.copyFileSync(job.outputPath, dest);
      console.log(`Copied to ${dest}`);
    }
  }
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
