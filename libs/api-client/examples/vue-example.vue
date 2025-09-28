<template>
  <div class="books-app">
    <!-- Login Form -->
    <form @submit.prevent="login" v-if="!user">
      <input
        v-model="email"
        type="email"
        placeholder="Email"
        required
      />
      <input
        v-model="password"
        type="password"
        placeholder="Password"
        required
      />
      <button type="submit" :disabled="loading">
        {{ loading ? 'Logging in...' : 'Login' }}
      </button>
      <div v-if="error" class="error">{{ error }}</div>
    </form>

    <!-- User Dashboard -->
    <div v-if="user">
      <h2>Welcome, {{ user.email }}!</h2>
      <button @click="logout">Logout</button>
      
      <!-- Books List -->
      <div class="books">
        <h3>Books</h3>
        <div v-for="book in books" :key="book.id" class="book">
          <h4>{{ book.title }}</h4>
          <p>{{ book.description }}</p>
          <button @click="addToBookshelf(book.id)">
            Add to Bookshelf
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { BooksApiClient } from '../src/index';

const api = new BooksApiClient({
  baseURL: process.env.VUE_APP_API_URL || 'http://localhost:5000'
});

const user = ref(null);
const books = ref([]);
const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

const login = async () => {
  loading.value = true;
  error.value = '';
  
  try {
    await api.login({
      email: email.value,
      password: password.value
    });
    
    user.value = await api.users.getMe();
    await fetchBooks();
  } catch (err: any) {
    error.value = err.response?.data?.message || 'Login failed';
  } finally {
    loading.value = false;
  }
};

const logout = async () => {
  await api.logout();
  user.value = null;
  books.value = [];
};

const fetchBooks = async () => {
  try {
    books.value = await api.books.getAll({ limit: 10 });
  } catch (err) {
    console.error('Failed to fetch books:', err);
  }
};

const addToBookshelf = async (bookId: string) => {
  try {
    await api.bookshelf.add(bookId);
    alert('Book added to bookshelf!');
  } catch (err) {
    alert('Failed to add book to bookshelf');
  }
};

onMounted(() => {
  // Try to load user if already authenticated
  api.users.getMe().then(userData => {
    user.value = userData;
    fetchBooks();
  }).catch(() => {
    // User not authenticated
  });
});
</script>

<style scoped>
.books-app {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
}

.book {
  border: 1px solid #ddd;
  padding: 15px;
  margin: 10px 0;
  border-radius: 5px;
}

.error {
  color: red;
  margin: 10px 0;
}
</style>
