const express = require("express");
const { createWSControllers } = require("../controllers/ws");
const { asyncRoute } = require("../middleware/http");

function createWSRouter(manager) {
  const router = express.Router();
  const controllers = createWSControllers(manager);

  router.post("/open", asyncRoute(controllers.open));
  router.post("/close", asyncRoute(controllers.close));

  return router;
}

module.exports = { createWSRouter };
