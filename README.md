# 📦 RedisStore for Baileys

The `RedisStore` class provides an efficient way to manage and cache messages, chats, contacts, and more using Redis. This class integrates seamlessly with the [Baileys library](https://github.com/whiskeysockets/baileys) and offers a robust solution for handling and storing WhatsApp-related data.

## 🚀 Features

- **🔗 Redis Integration:** Connects to a Redis server to store and manage data.
- **🔄 Event Handling:** Listens and responds to various Baileys events such as connection updates and message reactions.
- **💾 Data Caching:** Implements caching for messages to improve performance and reduce Redis load.
- **🔍 Message Search:** Provides functionality to search for messages based on different criteria.
- **🗑️ Data Clearing:** Allows clearing all cached data from Redis and local storage.

## 🛠️ Installation

To use `RedisStore`, you'll need to install the necessary dependencies. Run the following command:

```bash
npm install baileys-redis-store
```

## ⚙️ Configuration

To set up `RedisStore`, create a new instance by providing the required configuration options:

```typescript
import pino from 'pino';
import { RedisStore } from 'baileys-redis-store'; // Adjust the import path as necessary

// Create a Redis client with connection options
const redisClient: RedisClientType = createClient({
    url: "YOUR REDIS URL"
});

// Create a RedisStore instance for managing WhatsApp session data
const store = new RedisStore({
    redisConnection: redisClient,
    prefix: 'store', // Optional prefix for Redis keys
    logger: pino({ level: 'debug' }), // Optional Pino logger instance
    maxCacheSize: 5000, // Maximum number of messages to cache locally (defaults to 1000)
});
```

## 📋 Methods

### `disconnect`

```typescript
async disconnect(): Promise<void>
```

Disconnects from the Redis server. 🔌

### `bind`

```typescript
async bind(ev: Partial<EventEmitter>): Promise<void>
```

Binds event handlers to the specified event emitter. 🛠️

### `loadMessage`

```typescript
async loadMessage(jid: string, id: string): Promise<WAMessage | undefined>
```

Loads a single message from the cache or database. 📩

### `loadMessages`

```typescript
async loadMessages(jid: string, count: number, cursor?: { before?: WAMessageKey }): Promise<WAMessage[]>
```

Loads a list of messages from the database. 🗂️

### `getMessage`

```typescript
async getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined>
```

Retrieves the content of a message. 📝

### `searchMessages`

```typescript
async searchMessages(options: MessageSearchOptions): Promise<WAMessage[]>
```

Searches for messages based on the given criteria. 🔍

### `getChat`

```typescript
async getChat(jid: string): Promise<Chat | null>
```

Retrieves chat details from the database. 💬

### `getContact`

```typescript
async getContact(jid: string): Promise<Contact | null>
```

Retrieves contact details from the database. 👤

### `getGroup`

```typescript
async getGroup(jid: string): Promise<GroupMetadata | null>
```

Retrieves group metadata from the database. 🧑‍🤝‍🧑

### `clearAll`

```typescript
async clearAll(): Promise<void>
```

Clears all data from the Redis cache and local cache. 🗑️

## 📚 Usage Example

Here's a basic example of how to use the `RedisStore`:

```typescript
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { RedisStore } from 'baileys-redis-store'; // Import RedisStore for managing Redis-based session storage
import pino from 'pino'; // Import Pino for logging
import { createClient, RedisClientType } from 'redis'; // Import Redis client utilities

/**
 * Main function to set up the WhatsApp socket connection and Redis store.
 */
async function main() {
    // Create a Redis client with connection options
    const redisClient: RedisClientType = createClient({
        url: "YOUR REDIS URL"
    });

    // Handle Redis connection errors
    redisClient.on('error', (err) => {
        console.error('Redis Client Error:', err);
        // Optionally attempt to reconnect
        // setTimeout(() => redisClient.connect(), 5000); // Retry connection after 5 seconds
    });

    // Connect to the Redis server
    try {
        await redisClient.connect();
        console.log('Connected to Redis successfully!');
    } catch (error) {
        console.error('Error connecting to Redis:', error);
        return; // Exit if connection fails
    }

    // Create a RedisStore instance for managing Baileys store data
    const store = new RedisStore({
        redisConnection: redisClient,
        prefix: 'store', // Optional prefix for Redis keys
        logger: pino({ level: 'debug' }), // Optional Pino logger instance
        maxCacheSize: 5000, // Maximum number of messages to cache locally (defaults to 1000)
    });

    // Load authentication state from multi-file storage
    const { state, saveCreds } = await useMultiFileAuthState('./Test');

    // Create a WhatsApp socket connection with the specified configuration
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        getMessage: store.getMessage.bind(store), // Bind the context for getMessage method
    });

    // Listen for credentials updates and save them
    sock.ev.on('creds.update', saveCreds);

    // Bind the store to the WhatsApp socket event emitter
    await store.bind(sock.ev as any);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];

        // Example of loading a specific message by ID
        const loadMessage = store.loadMessage("12343434@jid", "04FC413D6BE3C1XXXX");
        
        // Example of loading the latest messages (up to 40) for a specific chat
        const loadMessages = store.loadMessages("12343434@jid", 40);
    });

    // Gracefully disconnect from Redis on process exit
    process.on('SIGINT', async () => {
        console.log('Disconnecting from Redis...');
        await redisClient.quit();
        console.log('Disconnected from Redis.');
        process.exit(0); // Exit cleanly
    });
}

// Execute the main function and handle any errors
main().catch((error) => {
    console.error('Main function error:', error);
});

```

## 🔗 Links

- [Baileys Documentation](https://github.com/whiskeysockets/baileys)
---
