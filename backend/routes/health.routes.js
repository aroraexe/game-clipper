'use strict';
const express = require('express');
const router  = express.Router();

router.get('/', (_req, res) => {
  let queue = null;
  try {
    queue = require('../jobs/renderQueue').getStats();
  } catch (_) {
    // Queue module may not be loaded yet during early boot in tests.
  }

  res.json({
    status:  'ok',
    service: 'storyplay',
    version: '1.0.0',
    time:    new Date().toISOString(),
    output:  {
      width:  parseInt(process.env.VIDEO_WIDTH, 10)  || 720,
      height: parseInt(process.env.VIDEO_HEIGHT, 10) || 1280,
    },
    queue,
  });
});

module.exports = router;
