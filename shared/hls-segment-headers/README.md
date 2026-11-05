# hls-segment-headers

Response headers the server sets on every on-the-fly HLS segment, read by the
player to tell a slow encoder from a slow network (feedback #178):

- `X-Photrix-Segment-Wait-Ms`: how long the request waited for the encoder to
  write the segment.
- `X-Photrix-Encode-Speed`: how fast that encoder is going, in multiples of
  realtime. Sent only when the request had to wait.
