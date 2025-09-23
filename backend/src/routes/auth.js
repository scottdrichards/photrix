const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../models/database');
const { generateToken, authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    const db = getDb();
    
    // Check if user already exists
    db.get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email], (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (row) {
        return res.status(400).json({ error: 'Username or email already exists' });
      }

      // Hash password
      bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
          return res.status(500).json({ error: 'Password hashing failed' });
        }

        // Insert new user
        db.run(
          'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
          [username, email, hash],
          function(err) {
            if (err) {
              return res.status(500).json({ error: 'Failed to create user' });
            }

            const token = generateToken({
              id: this.lastID,
              username,
              email
            });

            res.status(201).json({
              message: 'User created successfully',
              token,
              user: { id: this.lastID, username, email }
            });
          }
        );
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const db = getDb();
    
    // Find user by username or email
    db.get(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, username],
      (err, user) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }

        if (!user) {
          return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Compare password
        bcrypt.compare(password, user.password_hash, (err, isMatch) => {
          if (err) {
            return res.status(500).json({ error: 'Password verification failed' });
          }

          if (!isMatch) {
            return res.status(400).json({ error: 'Invalid credentials' });
          }

          const token = generateToken({
            id: user.id,
            username: user.username,
            email: user.email
          });

          res.json({
            message: 'Login successful',
            token,
            user: {
              id: user.id,
              username: user.username,
              email: user.email
            }
          });
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
// Get current user from token
router.get('/me', authenticateToken, (req, res) => {
  // req.user was set in authenticateToken
  const { id, username, email } = req.user;
  res.json({ user: { id, username, email } });
});