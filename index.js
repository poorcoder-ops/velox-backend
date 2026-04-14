require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

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
app.use(cookieParser());

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
          [null, repository.full_name, pull_request.number, 'pending']
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
      model: 'llama-3.1-8b-instant',
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
    const result = await pool.query(
      `SELECT * FROM reviews ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ reviews: result.rows });
  } catch (error) {
    console.error('Reviews fetch error:', error);
    res.status(500).json({ error: 'Internal error', details: error.message });
  }
});

// GitHub OAuth Login - redirect to GitHub
app.get('/api/auth/github', (req, res) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  // Use https - Render terminates SSL, req.protocol may incorrectly report http
  const redirectUri = `https://${req.get('host')}/api/auth/github/callback`;
  const state = crypto.randomBytes(16).toString('hex');

  // Store state in cookie for verification
  res.cookie('oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax' });

  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user,repo&state=${state}`;

  res.redirect(githubAuthUrl);
});

// GitHub OAuth Callback
app.get('/api/auth/github/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const storedState = req.cookies.oauth_state;

    // Verify state to prevent CSRF
    if (!state || state !== storedState) {
      return res.status(400).json({ error: 'Invalid OAuth state' });
    }

    // Clear the state cookie
    res.clearCookie('oauth_state');

    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: `https://${req.get('host')}/api/auth/github/callback`
      })
    });

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(400).json({ error: 'Failed to get access token', details: tokenData });
    }

    // Get user info from GitHub
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    const githubUser = await userResponse.json();

    // Upsert user in database
    const result = await pool.query(
      `INSERT INTO users (github_id, github_username, access_token, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (github_id) DO UPDATE SET
         github_username = $2,
         access_token = $3,
         updated_at = NOW()
       RETURNING id`,
      [githubUser.id, githubUser.login, accessToken]
    );

    const user = result.rows[0];

    // Create JWT
    const token = jwt.sign(
      { userId: user.id, githubId: githubUser.id, username: githubUser.login },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Set token in cookie
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    // Redirect to frontend dashboard
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?login=success`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ error: 'OAuth failed', details: error.message });
  }
});

// Get current user
app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      return res.json({ user: null, authenticated: false });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get fresh user data from database
    const result = await pool.query(
      `SELECT id, github_id, github_username, created_at FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ user: null, authenticated: false });
    }

    res.json({
      user: result.rows[0],
      authenticated: true
    });
  } catch (error) {
    console.error('Auth check error:', error);
    res.json({ user: null, authenticated: false });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Velox backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});