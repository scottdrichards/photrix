import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

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

// Basic routes (to be expanded)
app.get('/api/photos', (req, res) => {
  res.json({ photos: [], total: 0, message: 'No photos uploaded yet' })
})

app.post('/api/photos/upload', (req, res) => {
  res.status(501).json({ 
    error: 'Upload functionality not yet implemented',
    message: 'This feature will be available in the next phase'
  })
})

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message)
  res.status(500).json({ 
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
})