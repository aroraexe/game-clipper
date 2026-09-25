'use strict';
const express          = require('express');
const router           = express.Router();
const gameplayCtrl     = require('../controllers/gameplay.controller');

router.get('/',          gameplayCtrl.listGameplay);
router.get('/:gameId',   gameplayCtrl.getGameplay);

module.exports = router;
