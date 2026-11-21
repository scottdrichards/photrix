# face-crop

Which part of a photo a face crop shows: the detected face box, grown by a
margin for hair and chin, and kept inside the photo.

The client asks for this region in the crop URL, and the server caches the
result under it. The server also makes the People list's crops ahead of time,
and those are only found again if it computes the very same region, so both
sides take it from here.
