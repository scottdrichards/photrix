# @photrix/video-storyboard

The layout of a video's storyboard: the sprite of small frames the viewer shows
while you drag through a video (feedback #168). The server builds the sprite
and the client finds a frame in it, so both read the same plan from here.

- One frame every `intervalSeconds`, at least 2 s apart and at most 100 frames,
  so a 3-minute clip gets a frame every 2 s and an hour gets one every 36 s.
- Frame `i` is taken from the middle of its slot, `(i + 0.5) × interval`.
- Frames are laid out left to right, top to bottom, `columns` to a row. Every
  frame is the same size, so the client positions them by percentage and never
  needs the pixel size.
