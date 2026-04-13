require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || `https://${process.env.SUPABASE_HOST}`,
  process.env.SUPABASE_SERVICE_KEY
);

// PostgreSQL pool - force IPv4 to avoid IPv6 routing issues
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000
});

// Force IPv4 DNS resolution
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

// Groq client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GitHub Webhook Receiver
app.post('/api/webhooks/github', async (req, res) => {
  try {
    const event = req.headers['x-github-event'];
    const deliveryId = req.headers['x-github-delivery-id'];

    console.log(`Received webhook: ${event} (${deliveryId})`);

    if (event === 'pull_request') {
      const { action, pull_request, repository } = req.body;

      // Only process when PR is opened or updated
      if (action === 'opened' || action === 'synchronize') {
        console.log(`Processing PR #${pull_request.number} from ${repository.full_name}`);

        // Store the review job
        await pool.query(
          `INSERT INTO reviews (user_id, repository, pull_request_number, status)
           VALUES ($1, $2, $3, $4)`,
          ['pending-user', repository.full_name, pull_request.number, 'pending']
        );

        // Queue for AI processing (simplified - no actual queue in MVP)
        processReview(repository.full_name, pull_request.number, pull_request);
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Process review with AI
async function processReview(repoFullName, prNumber, prData) {
  try {
    console.log(`Reviewing PR #${prNumber} from ${repoFullName}`);

    // Build prompt for code review
    const prompt = `You are Velox, an expert code reviewer. Analyze the following pull request.

PR Title: ${prData.title || 'No title'}
PR Body: ${prData.body || 'No description'}

Repository: ${repoFullName}

Review the code changes and identify:
1. Bugs and logic errors
2. Security vulnerabilities
3. Performance issues
4. Code quality improvements
5. Best practices violations

For each issue found, provide:
- Severity: critical/high/medium/low
- Description: what the problem is
- Suggestion: how to fix it

Be thorough but concise. Focus on the most important issues.`;

    // Call Groq API
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are Velox, an expert code reviewer. Be thorough and helpful.' },
        { role: 'user', content: prompt }
      ],
      model: 'mixtral-8x7b-32768',
      temperature: 0.7,
    });

    const review = completion.choices[0]?.message?.content || 'No review generated';

    console.log(`Review complete for PR #${prNumber}`);
    console.log(review);

    // Update review status
    await pool.query(
      `UPDATE reviews SET status = $1, claude_response = $2, completed_at = NOW()
       WHERE repository = $3 AND pull_request_number = $4`,
      ['completed', review, repoFullName, prNumber]
    );

    return review;
  } catch (error) {
    console.error('Review processing error:', error);

    // Mark as failed
    await pool.query(
      `UPDATE reviews SET status = $1 WHERE repository = $2 AND pull_request_number = $3`,
      ['failed', repoFullName, prNumber]
    );

    return null;
  }
}

// Waitlist endpoint
app.post('/api/waitlist', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const result = await pool.query(
      `INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ message: 'Already on waitlist', position: 'unknown' });
    }

    // Get position
    const count = await pool.query(`SELECT COUNT(*) as position FROM waitlist WHERE created_at <= (SELECT created_at FROM waitlist WHERE id = $1)`, [result.rows[0].id]);

    res.json({ message: 'Added to waitlist', position: parseInt(count.rows[0].position) });
  } catch (error) {
    console.error('Waitlist error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Get waitlist position
app.get('/api/waitlist/position/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const result = await pool.query(`SELECT position FROM (
      SELECT email, ROW_NUMBER() OVER (ORDER BY created_at) as position FROM waitlist
    ) sub WHERE email = $1`, [email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not on waitlist' });
    }

    res.json({ position: result.rows[0].position });
  } catch (error) {
    console.error('Waitlist position error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Reviews list
app.get('/api/reviews', async (req, res) => {
  try {
    // Test DB connection first
    const testResult = await pool.query('SELECT NOW()');
    console.log('DB connected:', testResult.rows);

    const result = await pool.query(
      `SELECT * FROM reviews ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ reviews: result.rows });
  } catch (error) {
    console.error('Reviews fetch error:', error);
    res.status(500).json({ error: 'Internal error', details: error.message });
  }
});

// Auth check (simplified)
app.get('/api/auth/me', (req, res) => {
  // In full implementation, verify session/JWT
  res.json({ user: null, authenticated: false });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Velox backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});