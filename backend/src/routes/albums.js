const express = require('express');
const { getDb } = require('../models/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Create new album
router.post('/', authenticateToken, (req, res) => {
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Album name is required' });
  }

  const db = getDb();
  
  db.run(
    'INSERT INTO albums (user_id, name, description) VALUES (?, ?, ?)',
    [req.user.id, name, description || ''],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to create album' });
      }

      res.status(201).json({
        id: this.lastID,
        user_id: req.user.id,
        name,
        description,
        created_at: new Date().toISOString()
      });
    }
  );
});

// Get user's albums
router.get('/', authenticateToken, (req, res) => {
  const db = getDb();
  
  const query = `
    SELECT a.*, 
           COUNT(ap.photo_id) as photo_count,
           p.file_path as cover_photo_path
    FROM albums a
    LEFT JOIN album_photos ap ON a.id = ap.album_id
    LEFT JOIN photos p ON a.cover_photo_id = p.id
    WHERE a.user_id = ?
    GROUP BY a.id
    ORDER BY a.updated_at DESC
  `;

  db.all(query, [req.user.id], (err, albums) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({ albums });
  });
});

// Get single album with photos
router.get('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  
  // First get album details
  db.get(
    'SELECT * FROM albums WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id],
    (err, album) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (!album) {
        return res.status(404).json({ error: 'Album not found' });
      }

      // Get photos in the album
      const photosQuery = `
        SELECT p.*, ap.added_at
        FROM photos p
        JOIN album_photos ap ON p.id = ap.photo_id
        WHERE ap.album_id = ?
        ORDER BY ap.added_at DESC
      `;

      db.all(photosQuery, [req.params.id], (err, photos) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }

        res.json({
          ...album,
          photos: photos.map(photo => ({
            ...photo,
            metadata: JSON.parse(photo.metadata || '{}'),
            tags: JSON.parse(photo.tags || '[]')
          }))
        });
      });
    }
  );
});

// Add photo to album
router.post('/:id/photos', authenticateToken, (req, res) => {
  const { photo_id } = req.body;
  const album_id = req.params.id;

  if (!photo_id) {
    return res.status(400).json({ error: 'Photo ID is required' });
  }

  const db = getDb();
  
  // Verify album ownership
  db.get(
    'SELECT id FROM albums WHERE id = ? AND user_id = ?',
    [album_id, req.user.id],
    (err, album) => {
      if (err || !album) {
        return res.status(404).json({ error: 'Album not found' });
      }

      // Verify photo ownership
      db.get(
        'SELECT id FROM photos WHERE id = ? AND user_id = ?',
        [photo_id, req.user.id],
        (err, photo) => {
          if (err || !photo) {
            return res.status(404).json({ error: 'Photo not found' });
          }

          // Add photo to album
          db.run(
            'INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?, ?)',
            [album_id, photo_id],
            function(err) {
              if (err) {
                return res.status(500).json({ error: 'Failed to add photo to album' });
              }

              if (this.changes === 0) {
                return res.status(409).json({ error: 'Photo already in album' });
              }

              res.json({ message: 'Photo added to album successfully' });
            }
          );
        }
      );
    }
  );
});

// Remove photo from album
router.delete('/:id/photos/:photoId', authenticateToken, (req, res) => {
  const { id: album_id, photoId: photo_id } = req.params;
  const db = getDb();
  
  // Verify album ownership
  db.get(
    'SELECT id FROM albums WHERE id = ? AND user_id = ?',
    [album_id, req.user.id],
    (err, album) => {
      if (err || !album) {
        return res.status(404).json({ error: 'Album not found' });
      }

      db.run(
        'DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?',
        [album_id, photo_id],
        function(err) {
          if (err) {
            return res.status(500).json({ error: 'Database error' });
          }

          if (this.changes === 0) {
            return res.status(404).json({ error: 'Photo not found in album' });
          }

          res.json({ message: 'Photo removed from album successfully' });
        }
      );
    }
  );
});

// Delete album
router.delete('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  
  db.run(
    'DELETE FROM albums WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Album not found' });
      }

      res.json({ message: 'Album deleted successfully' });
    }
  );
});

module.exports = router;