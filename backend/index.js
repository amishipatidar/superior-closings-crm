//main server file

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/api');

const app = express();

//middleware
app.use(cors());//allow all cross-origin requests
app.use(express.json());//middleware to parse JSON bodies

//routes
//API routes, prefixing them with /api
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
    res.send("CRM API is running!")
});

//start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`)
});