const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const exifReader = require('exif-reader');
const path = require('path');
const fs = require('fs').promises;
const { getDb } = require('../models/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Function to convert GPS coordinates from EXIF format to decimal degrees
function convertGPSToDecimal(gpsData) {
  if (!gpsData) return null;

  const { GPSLatitude, GPSLongitude, GPSLatitudeRef, GPSLongitudeRef } = gpsData;
  
  if (!GPSLatitude || !GPSLongitude) return null;

  // Convert degrees, minutes, seconds to decimal degrees
  const convertDMS = (degrees, minutes, seconds) => {
    return degrees + minutes / 60 + seconds / 3600;
  };

  try {
    const lat = convertDMS(GPSLatitude[0], GPSLatitude[1], GPSLatitude[2]);
    const lon = convertDMS(GPSLongitude[0], GPSLongitude[1], GPSLongitude[2]);

    // Apply direction modifiers (N/S, E/W)
    const latitude = GPSLatitudeRef === 'S' ? -lat : lat;
    const longitude = GPSLongitudeRef === 'W' ? -lon : lon;

    return { latitude, longitude };
  } catch (error) {
    console.error('Error converting GPS coordinates:', error);
    return null;
  }
}

// Function to extract EXIF data including GPS
async function extractEXIFData(filePath) {
  try {
    const imageBuffer = await fs.readFile(filePath);
    const sharpImage = sharp(imageBuffer);
    const { exif } = await sharpImage.metadata();
    
    if (exif) {
      const exifData = exifReader(exif);
      const gpsCoords = convertGPSToDecimal(exifData.gps);
      return {
        exifData,
        gpsCoords
      };
    }
  } catch (error) {
    console.error('Error extracting EXIF data:', error);
  }
  return { exifData: null, gpsCoords: null };
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
  limits: {
    fileSize: 25 * 1024 * 1024 // 10MB limit
  }
});

// Upload photos
router.post('/upload', authenticateToken, (req, res) => {
  upload.array('photos', 10)(req, res, (err) => {
    if (err) {
      // Handle multer errors
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File too large. Maximum size is 10MB per file.' });
        } else if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(413).json({ error: 'Too many files. Maximum is 10 files at once.' });
        } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: 'Unexpected file field.' });
        } else {
          return res.status(400).json({ error: err.message });
        }
      } else if (err.message === 'Only image files are allowed') {
        return res.status(400).json({ error: 'Only image files are allowed. Please select JPG, PNG, GIF, or WebP files.' });
      } else {
        return res.status(500).json({ error: 'Upload failed: ' + err.message });
      }
    }

    handleUpload(req, res);
  });
});

// Separate function to handle the actual upload processing
async function handleUpload(req, res) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos uploaded' });
    }

    const db = getDb();
    const uploadedPhotos = [];

    for (const file of req.files) {
      try {
        // Generate thumbnail
        const thumbnailPath = path.join(
          path.dirname(file.path),
          'thumb_' + path.basename(file.path)
        );

        const metadata = await sharp(file.path)
          .resize(300, 300, { 
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ quality: 80 })
          .toFile(thumbnailPath);

        // Get image dimensions and extract EXIF/GPS data
        const imageMetadata = await sharp(file.path).metadata();
        const { exifData, gpsCoords } = await extractEXIFData(file.path);

        // Insert photo record
        const photoData = {
          user_id: req.user.id,
          filename: file.filename,
          original_name: file.originalname,
          file_path: file.filename, // Store just the filename for serving via /uploads
          thumbnail_path: 'thumb_' + file.filename, // Store just the thumbnail filename
          file_size: file.size,
          mime_type: file.mimetype,
          width: imageMetadata.width,
          height: imageMetadata.height,
          metadata: JSON.stringify({...imageMetadata, exif: exifData}),
          latitude: gpsCoords ? gpsCoords.latitude : null,
          longitude: gpsCoords ? gpsCoords.longitude : null
        };

        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO photos (user_id, filename, original_name, file_path, thumbnail_path, 
             file_size, mime_type, width, height, metadata, latitude, longitude) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              photoData.user_id, photoData.filename, photoData.original_name,
              photoData.file_path, photoData.thumbnail_path, photoData.file_size,
              photoData.mime_type, photoData.width, photoData.height, photoData.metadata,
              photoData.latitude, photoData.longitude
            ],
            function(err) {
              if (err) reject(err);
              else {
                uploadedPhotos.push({
                  id: this.lastID,
                  ...photoData
                });
                resolve();
              }
            }
          );
        });
      } catch (error) {
        console.error('Error processing file:', file.originalname, error);
      }
    }

    res.json({
      message: `Successfully uploaded ${uploadedPhotos.length} photos`,
      photos: uploadedPhotos
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload photos' });
  }
}

// Get user's photos
router.get('/', authenticateToken, (req, res) => {
  const db = getDb();
  const { 
    page = 1, 
    limit = 20, 
    search = '', 
    tags = '', 
    minLat, 
    maxLat, 
    minLng, 
    maxLng 
  } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM photos WHERE user_id = ?';
  let params = [req.user.id];

  if (search) {
    query += ' AND (original_name LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  // Add location-based filtering if bounds are provided
  if (minLat && maxLat && minLng && maxLng) {
    query += ' AND latitude IS NOT NULL AND longitude IS NOT NULL';
    query += ' AND latitude >= ? AND latitude <= ? AND longitude >= ? AND longitude <= ?';
    params.push(
      parseFloat(minLat), 
      parseFloat(maxLat), 
      parseFloat(minLng), 
      parseFloat(maxLng)
    );
  }

  query += ' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  db.all(query, params, (err, photos) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    // Parse JSON fields
    const processedPhotos = photos.map(photo => ({
      ...photo,
      metadata: JSON.parse(photo.metadata || '{}'),
      tags: JSON.parse(photo.tags || '[]')
    }));

    res.json({
      photos: processedPhotos,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: processedPhotos.length
      }
    });
  });
});

// Get single photo
router.get('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  
  db.get(
    'SELECT * FROM photos WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id],
    (err, photo) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      res.json({
        ...photo,
        metadata: JSON.parse(photo.metadata || '{}'),
        tags: JSON.parse(photo.tags || '[]')
      });
    }
  );
});

// Delete photo
router.delete('/:id', authenticateToken, async (req, res) => {
  const db = getDb();
  
  // First get the photo to delete files
  db.get(
    'SELECT * FROM photos WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id],
    async (err, photo) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      try {
        // Delete files
        await fs.unlink(photo.file_path);
        if (photo.thumbnail_path) {
          await fs.unlink(photo.thumbnail_path);
        }
      } catch (error) {
        console.error('Error deleting files:', error);
      }

      // Delete from database
      db.run(
        'DELETE FROM photos WHERE id = ? AND user_id = ?',
        [req.params.id, req.user.id],
        (err) => {
          if (err) {
            return res.status(500).json({ error: 'Database error' });
          }
          res.json({ message: 'Photo deleted successfully' });
        }
      );
    }
  );
});

module.exports = router;