/**
 * React Example for Books API Client
 *
 * This is a usage example showing how to integrate the API client in a React application.
 * To use this in your React project:
 * 1. Install the required dependencies: npm install react @types/react
 * 2. Copy this file to your React project
 * 3. Import and use the components
 *
 * Note: This file is provided as a reference and may have TypeScript errors
 * in non-React environments. It will work correctly in a React project.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type React from 'react';
import { useState, useEffect } from 'react';
import { BooksApiClient } from '../src/index';

const api = new BooksApiClient({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:5000',
});

// Authentication component
export const LoginForm = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: any) => {
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

  return {
    render: () => ({
      type: 'form',
      props: {
        onSubmit: handleLogin,
        children: [
          {
            type: 'input',
            props: {
              type: 'email',
              value: email,
              onChange: (e: any) => setEmail(e.target.value),
              placeholder: 'Email',
              required: true,
            },
          },
          {
            type: 'input',
            props: {
              type: 'password',
              value: password,
              onChange: (e: any) => setPassword(e.target.value),
              placeholder: 'Password',
              required: true,
            },
          },
          error && {
            type: 'div',
            props: { className: 'error', children: error },
          },
          {
            type: 'button',
            props: {
              type: 'submit',
              disabled: loading,
              children: loading ? 'Logging in...' : 'Login',
            },
          },
        ],
      },
    }),
  };
};

// Books list component
export const BooksList = () => {
  const [books, setBooks] = useState<any[]>([]);
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

    void fetchBooks();
  }, []);

  if (loading) return { type: 'div', props: { children: 'Loading books...' } };
  if (error) return { type: 'div', props: { children: `Error: ${error}` } };

  return {
    type: 'div',
    props: {
      children: [
        { type: 'h2', props: { children: 'Books' } },
        ...books.map((book: any) => ({
          type: 'div',
          props: {
            key: book.id,
            children: [
              { type: 'h3', props: { children: book.title } },
              { type: 'p', props: { children: book.description } },
            ],
          },
        })),
      ],
    },
  };
};

// Book detail component
export const BookDetail = ({ slug }: { slug: string }) => {
  const [book, setBook] = useState<any>(null);
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

    void fetchBook();
  }, [slug]);

  if (loading) return { type: 'div', props: { children: 'Loading...' } };
  if (!book) return { type: 'div', props: { children: 'Book not found' } };

  return {
    type: 'div',
    props: {
      children: [
        { type: 'h1', props: { children: book.title } },
        { type: 'p', props: { children: book.description } },
        // Render other book details
      ],
    },
  };
};
