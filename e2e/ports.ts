// Dedicated ports for the isolated test instance so an agent can run the suite
// while a normal dev server (3000/5173) is also up, without either clobbering
// the other. The client's proxy target is pointed at the test API via env.
export const API_PORT = 3399;
export const CLIENT_PORT = 5273;
export const API_URL = `http://localhost:${API_PORT}`;
export const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;
