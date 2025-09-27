# Photrix Development Guide

## Quick Start

### Prerequisites
- Node.js 18+ and npm 9+
- PostgreSQL (for future database features)

### Setup Instructions

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd photrix
   npm run install:all
   ```

2. **Environment Configuration**
   ```bash
   cp server/.env.example server/.env
   # Edit server/.env with your configuration
   ```

3. **Start Development**
   ```bash
   npm run dev
   ```

   This starts both:
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3001

## Project Architecture

### Technology Stack
- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Icons**: Lucide React
- **State Management**: Zustand (ready for implementation)
- **HTTP Client**: Axios (ready for API calls)

### Directory Structure
```
photrix/
├── client/                 # Frontend React application
│   ├── src/
│   │   ├── components/     # Reusable React components
│   │   ├── pages/         # Page components
│   │   ├── hooks/         # Custom React hooks
│   │   ├── services/      # API service functions
│   │   ├── types/         # TypeScript type definitions
│   │   └── utils/         # Utility functions
│   ├── public/            # Static assets
│   └── dist/              # Production build output
├── server/                # Backend Node.js application
│   ├── src/
│   │   ├── routes/        # Express route handlers
│   │   ├── middleware/    # Express middleware
│   │   ├── models/        # Data models
│   │   ├── services/      # Business logic services
│   │   ├── types/         # TypeScript type definitions
│   │   └── utils/         # Utility functions
│   ├── uploads/           # File storage directory
│   │   ├── photos/        # Original uploaded photos
│   │   └── thumbnails/    # Generated thumbnails
│   └── dist/              # Compiled TypeScript output
├── docs/                  # Project documentation
├── MASTER PLAN.MD         # Complete implementation roadmap
└── README.md              # Project overview
```

## Current Implementation Status

### ✅ Completed Features
- Modern React + TypeScript frontend with Vite
- Express + TypeScript backend API
- Responsive UI layout with Tailwind CSS
- Collapsible filter panel
- Top menu bar with branding
- Thumbnail grid area (empty state)
- Photo details panel (bottom)
- View mode toggles (grid/list)
- Health check API endpoint
- Basic photo listing API endpoint
- Development environment setup
- Build and deployment configuration

### 🚧 Current UI Features
- **Top Menu Bar**: Photrix branding with search, settings, and user icons
- **Filter Panel**: Collapsible sidebar with date range, tags, and location filters
- **Main Photo Area**: Empty state with upload prompts and view mode controls
- **Details Panel**: Bottom panel for photo metadata (currently hidden)
- **Responsive Design**: Works on desktop and mobile devices

### 🔄 Next Phase (Ready for Implementation)
- File upload functionality with drag & drop
- Photo storage and thumbnail generation
- Database integration for metadata
- Photo grid display with lazy loading
- Full-screen photo viewer

## Development Commands

### Root Level Commands
```bash
npm run dev              # Start both client and server
npm run build            # Build both applications
npm run install:all      # Install all dependencies
npm run lint             # Lint both applications
npm run test             # Run all tests
```

### Client Commands
```bash
cd client
npm run dev              # Start development server
npm run build            # Build for production
npm run preview          # Preview production build
npm run lint             # Run ESLint
npm run test             # Run Vitest tests
```

### Server Commands
```bash
cd server
npm run dev              # Start development server with hot reload
npm run build            # Compile TypeScript
npm run start            # Start production server
npm run lint             # Run ESLint
npm run test             # Run Vitest tests
```

## API Endpoints

### Currently Available
- `GET /api/health` - Health check endpoint
- `GET /api/photos` - List photos (currently returns empty array)
- `POST /api/photos/upload` - Upload endpoint (returns 501 - not implemented)

### Planned Endpoints (Next Phase)
- `POST /api/auth/login` - User authentication
- `POST /api/auth/register` - User registration
- `GET /api/photos/:id` - Get photo details
- `PUT /api/photos/:id` - Update photo metadata
- `DELETE /api/photos/:id` - Delete photo
- `GET /api/photos/:id/thumbnail` - Get thumbnail
- `GET /api/photos/:id/image` - Get full image

## Code Style and Standards

### TypeScript Configuration
- Strict mode enabled
- Modern ES2020+ features
- Path mapping for clean imports
- Comprehensive type checking

### React Best Practices
- Functional components with hooks
- TypeScript for all components
- Consistent naming conventions
- Performance optimizations ready

### CSS/Styling
- Tailwind CSS utility classes
- Responsive design patterns
- Consistent spacing and colors
- Custom component classes defined

## Testing Strategy

### Current Setup
- Vitest for unit testing (configured but no tests yet)
- ESLint for code quality
- TypeScript for type checking

### Future Testing Plans
- Component testing with React Testing Library
- API endpoint testing
- E2E testing with Playwright
- Image processing testing
- Performance testing

## Deployment Considerations

### Production Build
```bash
npm run build
```

### Environment Variables
- Copy `server/.env.example` to `server/.env`
- Configure database connection
- Set JWT secrets
- Configure file storage paths

### Docker Support (Future)
- Dockerfile for containerization
- Docker Compose for full stack
- Environment-specific configurations

## Contributing Guidelines

### Code Standards
1. Use TypeScript for all new code
2. Follow existing naming conventions
3. Add proper error handling
4. Include JSDoc comments for functions
5. Ensure responsive design
6. Test on multiple browsers

### Git Workflow
1. Create feature branches from main
2. Use descriptive commit messages
3. Test before committing
4. Keep commits focused and atomic

### Pull Request Process
1. Ensure all tests pass
2. Update documentation if needed
3. Include screenshots for UI changes
4. Reference related issues

## Troubleshooting

### Common Issues

**Port Already in Use**
```bash
# Kill processes on ports 3000 or 3001
npx kill-port 3000 3001
```

**Module Not Found**
```bash
# Reinstall dependencies
rm -rf node_modules client/node_modules server/node_modules
npm run install:all
```

**Build Errors**
```bash
# Clean and rebuild
npm run build
```

### Getting Help
- Check the MASTER PLAN.MD for implementation details
- Review API documentation for endpoint specifications
- Check browser console for client-side errors
- Check server logs for backend issues

## Performance Considerations

### Current Optimizations
- Vite for fast development builds
- TypeScript for better IDE support
- Tailwind CSS for optimized styles
- Express with modern middleware

### Future Optimizations
- Image lazy loading
- Virtual scrolling for large photo sets
- Progressive image loading
- Caching strategies
- Database indexing
- CDN integration

---

This development guide will be updated as new features are implemented. For the complete implementation roadmap, see [MASTER PLAN.MD](../MASTER%20PLAN.MD).