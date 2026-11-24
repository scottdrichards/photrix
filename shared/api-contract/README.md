# @photrix/api-contract

The JSON shapes the server sends and the client reads, defined once: the face
cluster summaries, details, centroids, PCA points and review results the
people endpoints return, and the date histogram.

Types only. Nothing here imports from the client or the server. When the client
reshapes a response (a face's `path` becomes a `PhotoItem`), it derives its own
type from the one here with `Omit<...> & {...}` instead of copying the fields.

Add a type here when both sides use the same wire shape. Leave it out when the
two differ on purpose (the files list, moment stacks): the server's is the row,
the client's is the hydrated item.
