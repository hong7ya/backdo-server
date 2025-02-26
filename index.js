const express = require('express');
const wsRoutes = require('./routes/ws');

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('backdo server 작동 중');
});

app.use('/ws', wsRoutes);

app.listen(3000, () => {
  console.log('Serving on port 3000');
});
