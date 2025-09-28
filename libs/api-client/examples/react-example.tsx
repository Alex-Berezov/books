import React, { useState, useEffect } from 'react';
import { BooksApiClient } from '../src/index';

const api = new BooksApiClient({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:5000',
});

// Authentication component
export const LoginForm: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const tokens = await api.login({ email, password });
      console.log('Login successful:', tokens);
      // Handle successful login (e.g., redirect, update state)
    } catch (err: any) {
      setError(err.response?.data?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleLogin}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        required
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        required
      />
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={loading}>
        {loading ? 'Logging in...' : 'Login'}
      </button>
    </form>
  );
};

// Books list component
export const BooksList: React.FC = () => {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchBooks = async () => {
      try {
        const data = await api.books.getAll({ limit: 20 });
        setBooks(data);
      } catch (err: any) {
        setError('Failed to load books');
      } finally {
        setLoading(false);
      }
    };

    fetchBooks();
  }, []);

  if (loading) return <div>Loading books...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      <h2>Books</h2>
      {books.map((book: any) => (
        <div key={book.id}>
          <h3>{book.title}</h3>
          <p>{book.description}</p>
        </div>
      ))}
    </div>
  );
};

// Book detail component
export const BookDetail: React.FC<{ slug: string }> = ({ slug }) => {
  const [book, setBook] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchBook = async () => {
      try {
        const data = await api.books.getOverview(slug);
        setBook(data);
      } catch (err) {
        console.error('Failed to load book:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchBook();
  }, [slug]);

  if (loading) return <div>Loading...</div>;
  if (!book) return <div>Book not found</div>;

  return (
    <div>
      <h1>{(book as any).title}</h1>
      <p>{(book as any).description}</p>
      {/* Render other book details */}
    </div>
  );
};
