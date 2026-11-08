const express = require('express');
const { createSessionControllers } = require('../controllers/sessions');
const { asyncRoute } = require('../middleware/http');

function createSessionRouter(manager) {
  const router = express.Router();
  const controllers = createSessionControllers(manager);

  router.post('/', asyncRoute(controllers.register));
  router.get('/:id', asyncRoute(controllers.get));
  router.post('/:id/restart', asyncRoute(controllers.restart));
  router.delete('/:id', asyncRoute(controllers.release));
  router.post('/:id/calibrations/:owner', asyncRoute(controllers.createCalibration));
  router.delete('/:id/calibrations/:owner', asyncRoute(controllers.disposeCalibration));
  return router;
}

module.exports = { createSessionRouter };
