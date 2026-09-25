'use strict';
const gameplayService = require('../services/gameplay.service');

exports.listGameplay = (_req, res, next) => {
  try {
    const list = gameplayService.listAll();
    res.json({ gameplay: list });
  } catch (err) {
    next(err);
  }
};

exports.getGameplay = (req, res, next) => {
  try {
    const item = gameplayService.getById(req.params.gameId);
    if (!item) return res.status(404).json({ error: 'Gameplay not found' });
    res.json(item);
  } catch (err) {
    next(err);
  }
};
