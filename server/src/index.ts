import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import multer from 'multer'
import sharp from 'sharp'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import { v4 as uuidv4 } from 'uuid'

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// Ensure upload directories exist
const uploadsDir = join(__dirname, '../uploads')
const photosDir = join(uploadsDir, 'photos')
const thumbnailsDir = join(uploadsDir, 'thumbnails')

async function ensureDirectories() {
  try {
    await fs.mkdir(uploadsDir, { recursive: true })
    await fs.mkdir(photosDir, { recursive: true })
    await fs.mkdir(thumbnailsDir, { recursive: true })
  } catch (error) {
    console.error('Error creating directories:', error)
  }
}

// Initialize directories
await ensureDirectories()

// Configure multer for file uploads
const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff']
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`File type ${file.mimetype} is not supported`))
    }
  }
})

// Middleware
app.use(helmet())
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// Serve static files (uploaded photos and thumbnails)
app.use('/uploads', express.static(join(__dirname, '../uploads')))

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Photrix API is running',
    timestamp: new Date().toISOString(),
    version: '0.1.0'
  })
})

// In-memory storage for demo (replace with database later)
const photos: Array<{
  id: string
  filename: string
  originalName: string
  size: number
  mimetype: string
  uploadDate: string
  thumbnailPath?: string
}> = []

// Basic routes (to be expanded)
app.get('/api/photos', (req, res) => {
  res.json({ 
    photos: photos.map(photo => ({
      ...photo,
      url: `/uploads/photos/${photo.filename}`,
      thumbnailUrl: photo.thumbnailPath ? `/uploads/thumbnails/${photo.thumbnailPath}` : undefined
    })), 
    total: photos.length, 
    message: photos.length === 0 ? 'No photos uploaded yet' : `${photos.length} photos available`
  })
})

// Photo upload endpoint
app.post('/api/photos/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded',
        message: 'Please select a photo to upload'
      })
    }

    const fileId = uuidv4()
    const fileExtension = req.file.originalname.split('.').pop()?.toLowerCase() || 'jpg'
    const filename = `${fileId}.${fileExtension}`
    const thumbnailFilename = `thumb_${fileId}.jpg`

    // Save original image
    const photoPath = join(photosDir, filename)
    await fs.writeFile(photoPath, req.file.buffer)

    // Generate thumbnail (300px width, maintain aspect ratio)
    const thumbnailPath = join(thumbnailsDir, thumbnailFilename)
    await sharp(req.file.buffer)
      .resize(300, null, { 
        withoutEnlargement: true,
        fit: 'inside'
      })
      .jpeg({ quality: 85 })
      .toFile(thumbnailPath)

    // Store photo metadata
    const photoData = {
      id: fileId,
      filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadDate: new Date().toISOString(),
      thumbnailPath: thumbnailFilename
    }

    photos.push(photoData)

    console.log(`✅ Photo uploaded: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`)

    return res.json({
      success: true,
      message: 'Photo uploaded successfully',
      photo: {
        ...photoData,
        url: `/uploads/photos/${filename}`,
        thumbnailUrl: `/uploads/thumbnails/${thumbnailFilename}`
      }
    })

  } catch (error) {
    console.error('Upload error:', error)
    return res.status(500).json({
      error: 'Upload failed',
      message: error instanceof Error ? error.message : 'Unknown error occurred'
    })
  }
})

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message)
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: 'File size exceeds 50MB limit'
      })
    }
  }
  
  return res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', message: `Route ${req.path} not found` })
})

app.listen(PORT, () => {
  console.log(`🚀 Photrix server running on port ${PORT}`)
  console.log(`📸 API available at http://localhost:${PORT}/api`)
  console.log(`🏥 Health check: http://localhost:${PORT}/api/health`)
  console.log(`📁 Upload directory: ${uploadsDir}`)
})