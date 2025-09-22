const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const exifReader = require('exif-reader');
const convert = require('heic-convert');
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
      // Look for GPS data in GPSInfo (not gps)
      const gpsCoords = convertGPSToDecimal(exifData.GPSInfo || exifData.gps);
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
    // Accept standard image types and HEIC files
    if (file.mimetype.startsWith('image/') || 
        file.mimetype === 'image/heic' || 
        file.mimetype === 'image/heif' ||
        file.originalname.toLowerCase().endsWith('.heic') ||
        file.originalname.toLowerCase().endsWith('.heif')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (including HEIC)'));
    }
  },
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB limit (increased for HEIC files)
  }
});

// Upload photos
router.post('/upload', authenticateToken, (req, res) => {
  upload.array('photos', 10)(req, res, (err) => {
    if (err) {
      // Handle multer errors
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File too large. Maximum size is 25MB per file.' });
        } else if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(413).json({ error: 'Too many files. Maximum is 10 files at once.' });
        } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: 'Unexpected file field.' });
        } else {
          return res.status(400).json({ error: err.message });
        }
      } else if (err.message === 'Only image files are allowed (including HEIC)') {
        return res.status(400).json({ error: 'Only image files are allowed. Please select JPG, PNG, GIF, WebP, or HEIC files.' });
      } else {
        return res.status(500).json({ error: 'Upload failed: ' + err.message });
      }
    }

    handleUpload(req, res);
  });
});

// Function to check if a file is HEIC format
function isHEICFile(file) {
  return file.mimetype === 'image/heic' || 
         file.mimetype === 'image/heif' ||
         file.originalname.toLowerCase().endsWith('.heic') ||
         file.originalname.toLowerCase().endsWith('.heif');
}

// Function to convert HEIC to JPEG
async function convertHEICToJPEG(inputPath) {
  try {
    const inputBuffer = await fs.readFile(inputPath);
    const outputBuffer = await convert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.9
    });
    
    // Write converted file back to the same path with .jpg extension
    const outputPath = inputPath.replace(/\.(heic|heif)$/i, '.jpg');
    await fs.writeFile(outputPath, outputBuffer);
    
    // Delete original HEIC file
    await fs.unlink(inputPath);
    
    return outputPath;
  } catch (error) {
    console.error('HEIC conversion error:', error);
    throw new Error('Failed to convert HEIC file');
  }
}

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
        let processedFilePath = file.path;
        let processedFilename = file.filename;
        let processedMimeType = file.mimetype;
        let gpsCoords = null;
        let exifData = null;

        // Extract EXIF/GPS data BEFORE conversion (for HEIC files)
        if (isHEICFile(file)) {
          console.log(`Extracting EXIF from HEIC file: ${file.originalname}`);
          const exifResult = await extractEXIFData(file.path);
          exifData = exifResult.exifData;
          gpsCoords = exifResult.gpsCoords;
          
          console.log(`Converting HEIC file: ${file.originalname}`);
          processedFilePath = await convertHEICToJPEG(file.path);
          processedFilename = path.basename(processedFilePath);
          processedMimeType = 'image/jpeg';
          console.log(`HEIC conversion complete: ${processedFilename}`);
        } else {
          // Extract EXIF/GPS from non-HEIC files normally
          const exifResult = await extractEXIFData(processedFilePath);
          exifData = exifResult.exifData;
          gpsCoords = exifResult.gpsCoords;
        }

        // Generate thumbnail
        const thumbnailPath = path.join(
          path.dirname(processedFilePath),
          'thumb_' + path.basename(processedFilePath)
        );

        const metadata = await sharp(processedFilePath)
          .resize(300, 300, { 
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ quality: 80 })
          .toFile(thumbnailPath);

        // Get image dimensions
        const imageMetadata = await sharp(processedFilePath).metadata();

        // Insert photo record
        const photoData = {
          user_id: req.user.id,
          filename: processedFilename,
          original_name: file.originalname,
          file_path: processedFilename, // Store just the filename for serving via /uploads
          thumbnail_path: 'thumb_' + processedFilename, // Store just the thumbnail filename
          file_size: file.size,
          mime_type: processedMimeType,
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

// Maintenance: Reprocess EXIF for photos missing GPS (per-user)
router.post('/reprocess-exif', authenticateToken, async (req, res) => {
  const db = getDb();
  try {
    // Fetch user's photos missing latitude/longitude
    const photos = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM photos WHERE user_id = ? AND (latitude IS NULL OR longitude IS NULL)',
        [req.user.id],
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });

    if (!photos.length) {
      return res.json({ message: 'No photos need EXIF GPS reprocessing', updated: 0 });
    }

    let updated = 0;
    for (const photo of photos) {
      try {
        const fullPath = path.join(__dirname, '../../uploads', photo.file_path);
        // Ensure file exists before processing
        try {
          await fs.access(fullPath);
        } catch {
          console.warn('File missing for EXIF reprocess:', fullPath);
          continue;
        }
        const { exifData, gpsCoords } = await extractEXIFData(fullPath);
        if (gpsCoords) {
          await new Promise((resolve, reject) => {
            db.run(
              'UPDATE photos SET latitude = ?, longitude = ?, metadata = ? WHERE id = ? AND user_id = ?',
              [
                gpsCoords.latitude,
                gpsCoords.longitude,
                // Merge existing metadata with new exif if possible
                (() => {
                  let meta = {};
                  try { meta = JSON.parse(photo.metadata || '{}'); } catch {}
                  return JSON.stringify({ ...meta, exif: exifData });
                })(),
                photo.id,
                req.user.id
              ],
              (err) => err ? reject(err) : resolve()
            );
          });
          updated++;
        }
      } catch (innerErr) {
        console.error('Error reprocessing EXIF for photo', photo.id, innerErr);
      }
    }

    res.json({ message: `Reprocess complete`, candidates: photos.length, updated });
  } catch (error) {
    console.error('Reprocess EXIF error:', error);
    res.status(500).json({ error: 'Failed to reprocess EXIF data' });
  }
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