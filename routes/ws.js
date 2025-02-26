const express = require("express");
const wsControllers = require("../controllers/ws");

const router = express.Router();

router.post("/open", wsControllers.open);

router.post("/close", wsControllers.close);

module.exports = router;
