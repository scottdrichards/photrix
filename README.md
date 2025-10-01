# Photrix
A modern way to enjoy your photos. Think the functionality of Light Room, the reliability of your local storage, the ease of use of your phone gallery, and the AI of Google.

Mission:
- To allow people to enjoy photos of their past.

Objectives:
A user can easily ...
  - add pictures to the system
  - find pictures he or she knows exists
  - discover forgotten pictures
  - share pictures with friends, family, and others
The system can be used for local pictures as well

## General Interaction
User can upload a photo through convenient web techniques such as drag and drop, file system access api, etc. The client device resizes the image to a moderate resolution before sending. The server than indexes the files, saves it, and saves a thumbnail.

The general layout of the application is a menu bar for sign-out etc. at top, below that is a collapsable filter panel. Below that, and the main page is the thumbnail viewer. At the bottom of the screen is a details panel that shows details for a currently selected image (or images). There's a button to enter full-screen mode to show the currently selected image.

## Index
The system will index a photo by date taken, geolocation, ratings, favorites, keywords, caption, camera make, camera model, camera lens, etc. These can be filtered as well. For example, the filter panel will include a map view of all pictures currently shown. The system will generate AI tags for the images as part of the index. Facial recognition will be employed to help find pictures of people.

## sharing
A user can select a collection of photos or a filter set, and share those with a particular email address. 
for example, a user could share all pictures during a certain time period and place with someone. Or the person can share all pictures with a particular face in them.

# Tech Stack
Frontend should be Typescript Vite React and fluent ui v9
Backend should generally be node/npm but can be whatever is easiest to maintain.
Playwright and Jest should be used to thoroughly test the system. Tests should not be concerned with implementation details but general features expected of the application. 

## Development

To experiment with the current prototype:

1. Copy `server/.env.example` to `server/.env` and update the values to point at your media library (for quick tests you can keep the defaults).

2. Install dependencies for the backend and start the HTTP server (uses the paths from `.env` by default):
  ```powershell
  cd server
  npm install
  npm start
  ```
  The CLI reads configuration from the `.env` file; you can still override values with real environment variables when needed.

3. In a separate shell, start the client development server:
  ```powershell
  cd client
  npm install
  npm run dev
  ```

The client proxies `/api` and `/uploads` requests to `http://localhost:3000`, so keep the backend running while developing the UI.