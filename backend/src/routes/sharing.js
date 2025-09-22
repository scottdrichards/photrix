const express = require('express');
const { getDb } = require('../models/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Share photo or album
router.post('/', authenticateToken, (req, res) => {
  const { resource_type, resource_id, shared_with_email, permissions = 'view', expires_at } = req.body;

  if (!resource_type || !resource_id || !shared_with_email) {
    return res.status(400).json({ 
      error: 'Resource type, resource ID, and email are required' 
    });
  }

  if (!['photo', 'album'].includes(resource_type)) {
    return res.status(400).json({ error: 'Resource type must be "photo" or "album"' });
  }

  const db = getDb();
  
  // Verify resource ownership
  const resourceTable = resource_type === 'photo' ? 'photos' : 'albums';
  db.get(
    `SELECT id FROM ${resourceTable} WHERE id = ? AND user_id = ?`,
    [resource_id, req.user.id],
    (err, resource) => {
      if (err || !resource) {
        return res.status(404).json({ error: `${resource_type} not found` });
      }

      // Create share record
      db.run(
        `INSERT INTO shares (owner_id, shared_with_email, resource_type, resource_id, permissions, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, shared_with_email, resource_type, resource_id, permissions, expires_at],
        function(err) {
          if (err) {
            return res.status(500).json({ error: 'Failed to create share' });
          }

          res.status(201).json({
            id: this.lastID,
            resource_type,
            resource_id,
            shared_with_email,
            permissions,
            expires_at,
            created_at: new Date().toISOString()
          });
        }
      );
    }
  );
});

// Get shares created by user
router.get('/created', authenticateToken, (req, res) => {
  const db = getDb();
  
  const query = `
    SELECT s.*, 
           CASE 
             WHEN s.resource_type = 'photo' THEN p.original_name
             WHEN s.resource_type = 'album' THEN a.name
           END as resource_name
    FROM shares s
    LEFT JOIN photos p ON s.resource_type = 'photo' AND s.resource_id = p.id
    LEFT JOIN albums a ON s.resource_type = 'album' AND s.resource_id = a.id
    WHERE s.owner_id = ?
    ORDER BY s.created_at DESC
  `;

  db.all(query, [req.user.id], (err, shares) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({ shares });
  });
});

// Get shares received by user (shared with user's email)
router.get('/received', authenticateToken, (req, res) => {
  const db = getDb();
  
  const query = `
    SELECT s.*,
           u.username as owner_username,
           CASE 
             WHEN s.resource_type = 'photo' THEN p.original_name
             WHEN s.resource_type = 'album' THEN a.name
           END as resource_name,
           CASE 
             WHEN s.resource_type = 'photo' THEN p.thumbnail_path
             WHEN s.resource_type = 'album' THEN cover_p.thumbnail_path
           END as thumbnail_path
    FROM shares s
    JOIN users u ON s.owner_id = u.id
    LEFT JOIN photos p ON s.resource_type = 'photo' AND s.resource_id = p.id
    LEFT JOIN albums a ON s.resource_type = 'album' AND s.resource_id = a.id
    LEFT JOIN photos cover_p ON s.resource_type = 'album' AND a.cover_photo_id = cover_p.id
    WHERE s.shared_with_email = ? 
      AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
    ORDER BY s.created_at DESC
  `;

  db.all(query, [req.user.email], (err, shares) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({ shares });
  });
});

// Get shared resource content
router.get('/resource/:shareId', authenticateToken, (req, res) => {
  const db = getDb();
  
  // First verify the share exists and user has access
  db.get(
    `SELECT s.* FROM shares s 
     WHERE s.id = ? AND 
           (s.shared_with_email = ? OR s.owner_id = ?) AND
           (s.expires_at IS NULL OR s.expires_at > datetime('now'))`,
    [req.params.shareId, req.user.email, req.user.id],
    (err, share) => {
      if (err || !share) {
        return res.status(404).json({ error: 'Share not found or expired' });
      }

      if (share.resource_type === 'photo') {
        // Get photo details
        db.get(
          'SELECT * FROM photos WHERE id = ?',
          [share.resource_id],
          (err, photo) => {
            if (err || !photo) {
              return res.status(404).json({ error: 'Photo not found' });
            }

            res.json({
              share_info: share,
              resource: {
                ...photo,
                metadata: JSON.parse(photo.metadata || '{}'),
                tags: JSON.parse(photo.tags || '[]')
              }
            });
          }
        );
      } else if (share.resource_type === 'album') {
        // Get album with photos
        db.get(
          'SELECT * FROM albums WHERE id = ?',
          [share.resource_id],
          (err, album) => {
            if (err || !album) {
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

            db.all(photosQuery, [share.resource_id], (err, photos) => {
              if (err) {
                return res.status(500).json({ error: 'Database error' });
              }

              res.json({
                share_info: share,
                resource: {
                  ...album,
                  photos: photos.map(photo => ({
                    ...photo,
                    metadata: JSON.parse(photo.metadata || '{}'),
                    tags: JSON.parse(photo.tags || '[]')
                  }))
                }
              });
            });
          }
        );
      }
    }
  );
});

// Delete share
router.delete('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  
  db.run(
    'DELETE FROM shares WHERE id = ? AND owner_id = ?',
    [req.params.id, req.user.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Share not found' });
      }

      res.json({ message: 'Share deleted successfully' });
    }
  );
});

module.exports = router;