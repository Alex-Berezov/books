const { BooksApiClient } = require('../dist/index');

// Initialize API client
const api = new BooksApiClient({
  baseURL: process.env.API_URL || 'http://localhost:5000',
});

// Example: Server-side API usage
async function serverSideExample() {
  try {
    // Get books for homepage
    const books = await api.books.getAll({ limit: 10 });
    console.log('Featured books:', books);

    // Get categories for navigation
    const categories = await api.categories.getTree();
    console.log('Categories tree:', categories);

    // Health check
    const health = await api.health.liveness();
    console.log('API health:', health);
  } catch (error) {
    console.error('API Error:', error.message);
  }
}

// Example: Express.js middleware
function createApiMiddleware() {
  return (req, res, next) => {
    req.api = api;
    next();
  };
}

// Example: Express.js routes
async function setupRoutes(app) {
  app.use(createApiMiddleware());

  // Proxy route for books
  app.get('/books', async (req, res) => {
    try {
      const books = await req.api.books.getAll({
        limit: req.query.limit || 20,
        offset: req.query.offset || 0,
      });
      res.json(books);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch books' });
    }
  });

  // Book detail route
  app.get('/books/:slug', async (req, res) => {
    try {
      const book = await req.api.books.getOverview(req.params.slug);
      res.json(book);
    } catch (error) {
      if (error.response?.status === 404) {
        res.status(404).json({ error: 'Book not found' });
      } else {
        res.status(500).json({ error: 'Failed to fetch book' });
      }
    }
  });
}

module.exports = {
  serverSideExample,
  createApiMiddleware,
  setupRoutes,
  api,
};
