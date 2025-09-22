# Photrix API Documentation

## Overview
The Photrix API provides RESTful endpoints for photo organization, album management, user authentication, and content sharing.

Base URL: `http://localhost:3001/api` (development)

## Authentication
Most endpoints require JWT authentication. Include the token in the Authorization header:
```
Authorization: Bearer <jwt_token>
```

## Endpoints

### Authentication

#### POST /auth/register
Register a new user account.
```json
{
  "username": "string",
  "email": "string", 
  "password": "string"
}
```

#### POST /auth/login
Login with existing credentials.
```json
{
  "username": "string",
  "password": "string"
}
```

### Photos

#### GET /photos
Get user's photos with optional pagination and search.
Query parameters:
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 20)
- `search`: Search term for filename/description

#### POST /photos/upload
Upload one or more photos.
- Content-Type: multipart/form-data
- Field name: `photos` (supports multiple files)
- Max file size: 10MB per file
- Supported formats: JPEG, PNG, GIF, WebP

#### GET /photos/:id
Get single photo details by ID.

#### DELETE /photos/:id
Delete a photo by ID.

### Albums

#### GET /albums
Get user's albums with photo counts.

#### POST /albums
Create a new album.
```json
{
  "name": "string",
  "description": "string" 
}
```

#### GET /albums/:id
Get album details including all photos.

#### DELETE /albums/:id
Delete an album by ID.

#### POST /albums/:id/photos
Add photo to album.
```json
{
  "photo_id": "integer"
}
```

#### DELETE /albums/:id/photos/:photoId
Remove photo from album.

### Sharing

#### POST /sharing
Create a new share.
```json
{
  "resource_type": "photo|album",
  "resource_id": "integer",
  "shared_with_email": "string",
  "permissions": "view|comment|edit",
  "expires_at": "datetime|null"
}
```

#### GET /sharing/created
Get shares created by the user.

#### GET /sharing/received
Get shares received by the user.

#### GET /sharing/resource/:shareId
Get shared resource content.

#### DELETE /sharing/:id
Delete a share by ID.

### Health Check

#### GET /health
Check API health status.

## Response Format

### Success Response
```json
{
  "data": {},
  "message": "Success message"
}
```

### Error Response
```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

## Status Codes
- 200: Success
- 201: Created
- 400: Bad Request
- 401: Unauthorized
- 403: Forbidden
- 404: Not Found
- 500: Internal Server Error

## File Storage
- Uploaded files are stored in `/uploads` directory
- Thumbnails are automatically generated at `/uploads/thumb_*`
- File URLs: `/uploads/{filename}`

## Database Schema

### users
- id (PRIMARY KEY)
- username (UNIQUE)
- email (UNIQUE)
- password_hash
- created_at
- updated_at

### photos
- id (PRIMARY KEY)
- user_id (FOREIGN KEY)
- filename
- original_name
- file_path
- thumbnail_path
- file_size
- mime_type
- width
- height
- taken_at
- uploaded_at
- metadata (JSON)
- tags (JSON)
- description
- is_favorite

### albums
- id (PRIMARY KEY)
- user_id (FOREIGN KEY)
- name
- description
- cover_photo_id (FOREIGN KEY)
- created_at
- updated_at

### album_photos
- id (PRIMARY KEY)
- album_id (FOREIGN KEY)
- photo_id (FOREIGN KEY)
- added_at

### shares
- id (PRIMARY KEY)
- owner_id (FOREIGN KEY)
- shared_with_email
- resource_type
- resource_id
- permissions
- expires_at
- created_at