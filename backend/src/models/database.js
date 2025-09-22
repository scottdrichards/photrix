const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Database path - can be configured via environment variable
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../photrix.db');

let db;

// Initialize database connection and create tables
function init() {
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('Error opening database:', err);
    } else {
      console.log('Connected to SQLite database at:', DB_PATH);
      createTables();
    }
  });
}

// Create database tables
function createTables() {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Photos table
  db.run(`
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      filename VARCHAR(255) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      thumbnail_path VARCHAR(500),
      file_size INTEGER,
      mime_type VARCHAR(100),
      width INTEGER,
      height INTEGER,
      taken_at DATETIME,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT, -- JSON string for EXIF data
      tags TEXT, -- JSON array of tags
      description TEXT,
      is_favorite BOOLEAN DEFAULT 0,
      latitude REAL,
      longitude REAL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Add latitude and longitude columns to existing photos table if they don't exist
  db.run(`ALTER TABLE photos ADD COLUMN latitude REAL`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding latitude column:', err);
    }
  });

  db.run(`ALTER TABLE photos ADD COLUMN longitude REAL`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding longitude column:', err);
    }
  });

  // Albums table
  db.run(`
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      cover_photo_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (cover_photo_id) REFERENCES photos (id) ON DELETE SET NULL
    )
  `);

  // Album photos relationship table
  db.run(`
    CREATE TABLE IF NOT EXISTS album_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL,
      photo_id INTEGER NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (album_id) REFERENCES albums (id) ON DELETE CASCADE,
      FOREIGN KEY (photo_id) REFERENCES photos (id) ON DELETE CASCADE,
      UNIQUE(album_id, photo_id)
    )
  `);

  // Sharing table
  db.run(`
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      shared_with_email VARCHAR(255) NOT NULL,
      resource_type VARCHAR(50) NOT NULL, -- 'photo' or 'album'
      resource_id INTEGER NOT NULL,
      permissions VARCHAR(50) DEFAULT 'view', -- 'view', 'comment', 'edit'
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  console.log('Database tables created successfully');
}

// Get database instance
function getDb() {
  return db;
}

// Close database connection
function close() {
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      } else {
        console.log('Database connection closed');
      }
    });
  }
}

module.exports = {
  init,
  getDb,
  close
};