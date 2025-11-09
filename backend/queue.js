//queue.js
const {Queue} = require('bullmq');

//redis connection
const connection ={
    host: process.env.REDIS_HOST,
    post: process.env.REDIS_PORT,
}

//create a new queue
const messagingQueue = new Queue('messaging', {connection});
module.exports = {messagingQueue, connection}