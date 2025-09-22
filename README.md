# Photrix 📸

A modern photo organization and sharing application built for personal collections. Organize, discover, and share your favorite photos with friends and family.

## Features

### Core Features
- 📁 **Photo Organization**: Upload, organize, and manage your photo collection
- 🔍 **Smart Search**: Search through photos by filename, description, and metadata
- 📱 **Albums**: Create and manage photo albums for better organization
- 🤝 **Sharing**: Share individual photos or entire albums with others
- 🔐 **Access Control**: Secure user authentication and permission management
- 💾 **Offline Support**: Progressive Web App with offline capabilities

### Technical Features
- 🏗️ **Standalone Architecture**: Frontend and backend can run independently
- 🖥️ **Client-side Processing**: Image thumbnails, metadata extraction, and optimization
- 📊 **SQLite Database**: Lightweight, embedded database for development
- 🔄 **RESTful API**: Clean API design for easy integration
- 📱 **Responsive Design**: Works on desktop, tablet, and mobile devices

## Quick Start

### Prerequisites
- Node.js (v14 or higher)
- Python 3 (for frontend development server)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/scottdrichards/photrix.git
   cd photrix
   ```

2. **Install dependencies:**
   ```bash
   npm run install:all
   ```

3. **Set up environment:**
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env with your preferred settings
   ```

4. **Start the application:**
   ```bash
   # Start both frontend and backend
   npm run dev
   
   # Or start individually:
   npm run dev:backend    # Backend on http://localhost:3001
   npm run dev:frontend   # Frontend on http://localhost:3000
   ```

5. **Open your browser:**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3001/api/health

## Architecture

### Backend (`/backend`)
- **Framework**: Express.js with Node.js
- **Database**: SQLite (configurable for PostgreSQL)
- **Authentication**: JWT-based authentication
- **File Storage**: Local filesystem (extensible to cloud storage)
- **Image Processing**: Sharp for thumbnails and optimization

### Frontend (`/frontend`)
- **Technology**: Vanilla JavaScript, HTML5, CSS3
- **Architecture**: Component-based modular design
- **Offline Support**: Service Worker for caching
- **Responsive**: CSS Grid and Flexbox layouts
- **Icons**: Font Awesome

### Key Components

#### Backend API Endpoints
- `/api/auth/*` - Authentication (login, register)
- `/api/photos/*` - Photo management (upload, list, delete)
- `/api/albums/*` - Album management
- `/api/sharing/*` - Sharing and access control

#### Frontend Modules
- `auth.js` - User authentication
- `photos.js` - Photo upload and management
- `albums.js` - Album organization
- `sharing.js` - Content sharing
- `app.js` - Main application controller

## Usage

### Getting Started
1. Create an account or login
2. Upload your first photos using the upload button
3. Organize photos into albums
4. Share individual photos or albums with friends

### Photo Management
- **Upload**: Drag and drop or click to select multiple photos
- **View**: Click on any photo to see full size and metadata
- **Search**: Use the search bar to find photos by name or description
- **Delete**: Remove photos you no longer want

### Album Organization
- **Create**: Click "Create Album" to make new collections
- **Add Photos**: Add existing photos to albums
- **Share Albums**: Share entire collections with others

### Sharing
- **Individual Photos**: Share specific photos via email
- **Albums**: Share entire albums with view permissions
- **Access Control**: Manage who can view your shared content

## Development

### Project Structure
```
photrix/
├── backend/                 # Backend API server
│   ├── src/
│   │   ├── routes/         # API route handlers
│   │   ├── models/         # Database models
│   │   ├── middleware/     # Authentication middleware
│   │   └── index.js        # Main server file
│   ├── uploads/            # Uploaded files storage
│   └── package.json
├── frontend/               # Frontend web application
│   ├── css/               # Stylesheets
│   ├── js/                # JavaScript modules
│   ├── index.html         # Main HTML file
│   └── sw.js              # Service worker
├── package.json           # Root package.json
└── README.md
```

### API Development
The backend provides a RESTful API that can be extended:

```javascript
// Example: Add new photo endpoint
router.get('/photos/favorites', authenticateToken, async (req, res) => {
  // Get user's favorite photos
});
```

### Frontend Development
The frontend is modular and can be extended:

```javascript
// Example: Add new feature
class FavoritesManager {
  // Manage favorite photos
}
```

### Database Schema
- **users**: User accounts and authentication
- **photos**: Photo metadata and file information
- **albums**: Photo album organization
- **album_photos**: Many-to-many relationship
- **shares**: Sharing permissions and access

## Deployment

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm run start
```

### Environment Variables
Key configuration options in `.env`:
- `PORT`: Backend server port (default: 3001)
- `JWT_SECRET`: Secret for JWT token signing
- `DB_PATH`: Database file location
- `UPLOAD_PATH`: File storage directory

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

- 📧 Create an issue for bug reports or feature requests
- 📖 Check the documentation for detailed API information
- 💬 Join discussions for community support
