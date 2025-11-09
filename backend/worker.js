require('dotenv').config();
const{Worker} = require('bullmq')
const{connection} = require('./queue')//import redis connection
const db = require('./db')//import database connection

// intitialize twilio and sendGrid
const twilio = require('twilio');
const twilioClient = twilio(
    process.env.TWILIO_ACCOUT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const sgMail = require('@sendgrid/mail')
sgMail.setApiKey(process.env.SENDGRID_API_KEY)

//define the job processing logic
const processor = async(job)=>{
    const {type, contact, message} = job.data;
    console.log(`Processing job ${job.id}: Sending ${type} to ${contact.name}`)
    try{
        if(type === 'sms'){
            await twilioClient.messages.create({
                body: message,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: contact.phone,
            });
        }
        else if(type === 'email'){
            //send email using sendGrid
            await sgMail.send({
                to: contact.send,
                from: 'superior.closings.dev@gmail.com',
                subject: 'An update from Superior Closings',
                text: message,
            });
        }

        //log the message to outreach_history in our database
        await db.query(
            `INSERT INTO outreach_history (contact_id, type, content, status)
            VALUES ($!, $2, $3, $4)`,
            [contact.id, type, message, 'sent']
        );

    } catch(error){
        console.error(`Job ${job.id} failed:`, error.message);

        //log the failure
        await db.query(
            `INSERT INTO outreavh_history(contact_id, type, contact, status)
            VALUES($!, $2, $3, $4)`,
            [contact.id, type, message, 'failed']
        );
        //re-throw the error to mark the job as failed in BullMQ
        throw error;
    }

};

//create and start the worker
const worker = new Worker('messaging', processor, {connection});
console.log('Worker listening for jobs...');
worker.on('completed', (job) =>{
    console.log(`Job ${job.id} has completed`)
});

worker.on('failed', (job, err)=>{
    console.log(`Job ${job.id} has failed with ${err.message}`)
});