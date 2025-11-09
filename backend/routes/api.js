// routes/api.js
const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const db = require('../db'); // Import our db connection

const router = express.Router();

// Set up multer for in-memory file storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- CSV Upload Endpoint ---
router.post('/upload/csv', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const results = [];
  const duplicates = [];
  const newContacts = [];

  // Create a readable stream from the file buffer
  const stream = Readable.from(req.file.buffer.toString());

  stream
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      // Now we have all rows in 'results'. Let's process them.
      for (const row of results) {
        const email = row.email;
        
        if (!email) {
            duplicates.push({ row: row, reason: 'Missing email' });
            continue; // Skip rows without an email
        }

        // 1. Deduplication check based on email
        const check = await db.query('SELECT id FROM contacts WHERE email = $1', [email]);

        if (check.rows.length > 0) {
          // It's a duplicate
          duplicates.push({ email: email, reason: 'Email already exists' });
        } else {
          // It's a new contact. Prepare for insertion.
          const { name, phone, organization, ...customFields } = row;
          newContacts.push({
            name: name || 'N/A',
            email: email,
            phone: phone || null,
            organization: organization || null,
            custom_fields: customFields // All other columns go into JSONB
          });
        }
      }

      // 2. Batch Insert new contacts
      if (newContacts.length > 0) {
        // We use a different method to build the query to prevent SQL injection
        // This is a bit more complex but safer.
        let values = [];
        let params = [];
        let counter = 1;

        for (const contact of newContacts) {
            params.push(contact.name, contact.email, contact.phone, contact.organization, contact.custom_fields);
            values.push(`($${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++})`);
        }
        
        const insertQuery = `INSERT INTO contacts (name, email, phone, organization, custom_fields) VALUES ${values.join(', ')} RETURNING id`;

        try {
          await db.query(insertQuery, params);
        } catch (err) {
          console.error('Batch insert error:', err);
          return res.status(500).json({ message: 'Error inserting contacts', error: err.message });
        }
      }

      // 3. Respond with a summary
      res.status(201).json({
        message: 'CSV processed',
        new_contacts_added: newContacts.length,
        duplicates_found: duplicates.length,
        duplicates: duplicates // Log duplicates
      });
    });
});

// --- Basic CRUD for Contacts ---

// GET all contacts
router.get('/contacts', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM contacts ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a single contact
router.get('/contacts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query('SELECT * FROM contacts WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).send('Contact not found');
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE a contact (e.g., from the dashboard)
router.put('/contacts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Ensure all fields are provided or set defaults
    const { name, email, phone, organization, status = 'active', custom_fields = {} } = req.body;
    
    const { rows } = await db.query(
      `UPDATE contacts SET 
        name = $1, email = $2, phone = $3, organization = $4, status = $5, custom_fields = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 RETURNING *`,
      [name, email, phone, organization, status, custom_fields, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).send('Contact not found');
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//will handle all incoming SMS from Twilio
// routes/api.js (add this new code)

// --- Twilio SMS Webhook ---
// This endpoint will be hit by Twilio when someone texts your number
router.post('/sms/inbound', async (req, res) => {
  const fromNumber = req.body.From;
  const messageBody = req.body.Body.trim().toUpperCase(); // Get message, trim, and uppercase

  console.log(`INCOMING SMS from ${fromNumber}: ${messageBody}`);

  try {
    // Find the contact in our database by their phone number
    const { rows } = await db.query('SELECT * FROM contacts WHERE phone = $1', [fromNumber]);

    if (rows.length === 0) {
      // If we don't know this number, we can't do anything
      console.log(`Unknown sender: ${fromNumber}`);
      return res.status(200).send('OK'); // Always send 200 to Twilio
    }

    const contact = rows[0];

    // --- Handle "STOP" for TCPA Compliance ---
    if (messageBody === 'STOP') {
      // Update their status to 'opted-out'
      await db.query("UPDATE contacts SET status = 'opted-out' WHERE id = $1", [contact.id]);
      console.log(`Contact ${contact.name} has OPTED OUT.`);
      
      // Log it
      await db.query(
        `INSERT INTO outreach_history (contact_id, type, content, status)
         VALUES ($1, $2, $3, $4)`,
        [contact.id, 'sms_inbound', messageBody, 'opted-out']
      );

    // --- Handle "YES" for Engagement ---
    } else if (messageBody === 'YES') {
      // Update their status to 'engaged'
      await db.query("UPDATE contacts SET status = 'engaged' WHERE id = $1", [contact.id]);
      console.log(`Contact ${contact.name} is ENGAGED.`);

      // Log it
      await db.query(
        `INSERT INTO outreach_history (contact_id, type, content, status)
         VALUES ($1, $2, $3, $4)`,
        [contact.id, 'sms_inbound', messageBody, 'engaged']
      );

    } else {
      // --- Handle any other message ---
      console.log(`Logging reply from ${contact.name}.`);
      
      // Just log any other reply to the history
      await db.query(
        `INSERT INTO outreach_history (contact_id, type, content, status)
         VALUES ($1, $2, $3, $4)`,
        [contact.id, 'sms_inbound', req.body.Body, 'replied']
      );
    }

    // Send a 200 OK response to Twilio to let them know we received it
    res.status(200).send('OK');

  } catch (err) {
    console.error('Error in Twilio webhook:', err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;