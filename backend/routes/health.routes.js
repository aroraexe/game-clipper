'use strict';
const express = require('express');
const router  = express.Router();

router.get('/', (_req, res) => {
  res.json({
    status:  'ok',
    service: 'storyplay',
    version: '1.0.0',
    time:    new Date().toISOString(),
  });
});

module.exports = router;
