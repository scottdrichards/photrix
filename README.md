# Photrix
A modern way to enjoy your photos. Think the functionality of LightRoom, the reliability of your local storage, the ease of use of your phone gallery, and the AI of Google.

Mission:
- To allow people to enjoy photos of their past.

Objectives:
A user can easily ...
  - add pictures to the system
  - find pictures he or she knows exists
  - discover forgotten pictures
  - share pictures with friends, family, and others

## General Interaction
User can upload a photo through convenient web techniques such as drag and drop, file system access api, etc. The client device resizes the image to a moderate resolution before sending. The server than indexes the files, saves it, and saves a thumbnail.

The general layout of the application is a menu bar for sign-out etc. at top, below that is a collapsable filter panel. Below that, and the main page is the thumbnail viewer. At the bottom of the screen is a details panel that shows details for a currently selected image (or images). There's a button to enter full-screen mode to show the currently selected image.

## Index
The system will index a photo by date taken, geolocation, ratings, favorites, keywords, caption, camera make, camera model, camera lens, etc. These can be filtered as well. For example, the filter panel will include a map view of all pictures currently shown. The system will generate AI tags for the images as part of the index. Facial recognition will be employed to help find pictures of people.

## sharing
A user can select a collection of photos or a filter set, and share those with a particular email address. 
for example, a user could share all pictures during a certain time period and place with someone. Or the person can share all pictures with a particular face in them.