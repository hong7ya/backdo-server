const express = require('express');
const { createWSControllers } = require('../controllers/ws');

function createWSRouter(manager, route) {
  const router = express.Router();
  const controllers = createWSControllers(manager);
  router.post('/open', route(controllers.open));
  router.post('/close', route(controllers.close));
  return router;
}

module.exports = { createWSRouter };
