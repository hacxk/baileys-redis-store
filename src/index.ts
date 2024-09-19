import { RedisClientType } from 'redis';
import { proto, WAMessageKey, BaileysEventMap, Chat, Contact, ConnectionState, GroupMetadata, PresenceData, WAMessage, WAMessageContent } from 'baileys';
import { jidNormalizedUser, updateMessageWithReaction, updateMessageWithReceipt } from 'baileys';
import pino from 'pino';
import { EventEmitter } from 'events';

interface RedisStoreConfig {
    redisConnection: RedisClientType;
    prefix?: string;
    logger?: pino.Logger;
    maxCacheSize?: number;
}

interface MessageSearchOptions {
    messageId?: string;
    remoteJid?: string;
    contentQuery?: string;
    limit?: number;
    offset?: number;
}

/**
 * A class for managing Redis - based storage and caching.
 */
export class RedisStore {
    /**
     * The Redis client instance for connecting to the Redis server.
     * @type {RedisClientType}
     */
    private client: RedisClientType;

    /**
     * The prefix used for Redis keys to avoid key collisions.
     * @type {string}
     */
    private prefix: string;

    /**
     * A logger instance for logging messages and errors.
     * @type {pino.Logger}
     */
    private logger: pino.Logger;

    /**
     * The maximum size of the cache before old entries are removed.
     * @type {number}
     */
    private maxCacheSize: number;

    /**
     * A cache to store messages temporarily.
     * @type {Map<string, WAMessage>}
     */
    private messageCache: Map<string, WAMessage>;

    /**
     * Creates an instance of RedisStore.
     * @param {RedisStoreConfig} config - Configuration options for the RedisStore.
     * @param {RedisClientType} config.redisConnection - The Redis client instance to use.
     * @param {string} [config.prefix='baileys:'] - Optional prefix for Redis keys.
     * @param {pino.Logger} [config.logger=pino({ name: 'baileys-store' })] - Optional logger instance.
     * @param {number} [config.maxCacheSize=1000] - Optional maximum cache size.
     */
    constructor({ redisConnection, prefix = 'baileys:', logger = pino({ name: 'baileys-store' }), maxCacheSize = 1000 }: RedisStoreConfig) {
        this.client = redisConnection;
        this.prefix = prefix;
        this.logger = logger;
        this.maxCacheSize = maxCacheSize;
        this.messageCache = new Map();
    }

    /**
     * Establishes a connection to the Redis server.
     * 
     * @returns {Promise<void>} - A promise that resolves when the connection is successfully established.
     */
    async connect(): Promise<void> {
        await this.client.connect();
        this.logger.info('Connected to Redis');
    }

    /**
     * Disconnects from the Redis server.
     * 
     * @returns {Promise<void>} - A promise that resolves when the disconnection is successfully completed.
     */
    async disconnect(): Promise<void> {
        await this.client.disconnect();
        this.logger.info('Disconnected from Redis');
    }

    /**
     * Generates a cache key based on the type and optional ID.
     * 
     * @param {string} type - The type of the cache entry (e.g., 'messages', 'contacts').
     * @param {string} [id] - The optional ID for the cache entry.
     * @returns {string} - The generated cache key.
     */
    private key(type: string, id?: string): string {
        return `${this.prefix}${type}:${id}`;
    }

    /**
     * Binds event handlers to the specified event emitter.
     * 
     * @param {Partial<EventEmitter>} ev - An object representing the event emitter to bind handlers to.
     * @returns {Promise<void>} - A promise that resolves when all event handlers have been successfully bound.
     */
    async bind(ev: Partial<EventEmitter>): Promise<void> {
        const handlers: { [K in keyof BaileysEventMap]?: (args: BaileysEventMap[K]) => void } = {
            'connection.update': this.handleConnectionUpdate.bind(this),
            'chats.upsert': this.handleChatsUpsert.bind(this),
            'contacts.upsert': this.handleContactsUpsert.bind(this),
            'messages.upsert': this.handleMessagesUpsert.bind(this),
            'groups.update': this.handleGroupsUpdate.bind(this),
            'message-receipt.update': this.handleMessageReceiptUpdate.bind(this),
            'messages.reaction': this.handleMessagesReaction.bind(this),
            'presence.update': this.handlePresenceUpdate.bind(this),
            'chats.delete': this.handleChatsDelete.bind(this),
            'messages.delete': this.handleMessagesDelete.bind(this),
        };

        for (const [event, handler] of Object.entries(handlers)) {
            ev.on?.(event as keyof EventEmitter, handler as any);
        }

        this.logger.info('Bound to Baileys events');
    }


    private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
        // Convert update object values to strings
        const stringifiedUpdate = Object.fromEntries(
            Object.entries(update).map(([key, value]) => [key, value !== undefined ? String(value) : 'null'])
        );

        await this.client.set(this.key('state', 'connection'), JSON.stringify(stringifiedUpdate));

        this.logger.debug({ update: stringifiedUpdate }, 'Connection state updated');
    }


    private async handleChatsUpsert(newChats: Chat[]): Promise<void> {
        const pipeline = this.client.multi();
        for (const chat of newChats) {
            pipeline.set(this.key('chats', chat.id), JSON.stringify(chat));
        }
        await pipeline.exec();
        this.logger.debug({ chatCount: newChats.length }, 'Chats upserted');
    }

    private async handleContactsUpsert(newContacts: Contact[]): Promise<void> {
        const pipeline = this.client.multi();
        for (const contact of newContacts) {
            pipeline.set(this.key('contacts', contact.id), JSON.stringify(contact));
        }
        await pipeline.exec();
        this.logger.debug({ contactCount: newContacts.length }, 'Contacts upserted');
    }

    private async handleMessagesUpsert({ messages, type }: { messages: WAMessage[], type: 'append' | 'notify' }): Promise<void> {
        const pipeline = this.client.multi();
        for (const msg of messages) {
            const jid = jidNormalizedUser(msg.key.remoteJid!);
            const messageKey = this.key('messages', `${jid}:${msg.key.id}`);
            pipeline.set(messageKey, JSON.stringify(msg));
            pipeline.zAdd(this.key('message_list', jid), { score: Number(msg.messageTimestamp), value: msg.key.id! });
            pipeline.sAdd(this.key('message_global_list'), `${jid}:${msg.key.id}`);
            
            this.updateMessageCache(msg);

            if (type === 'notify') {
                pipeline.hIncrBy(this.key('chats', jid), 'unreadCount', 1);
                pipeline.hSet(this.key('chats', jid), 'conversationTimestamp', String(msg.messageTimestamp));
            }
        }
        await pipeline.exec();
        this.logger.debug({ messageCount: messages.length, type }, 'Messages upserted');
    }

    private updateMessageCache(msg: WAMessage): void {
        const key = `${msg.key.remoteJid}:${msg.key.id}`;
        this.messageCache.set(key, msg);
        if (this.messageCache.size > this.maxCacheSize) {
            const oldestKey: string = this.messageCache.keys().next().value;
            this.messageCache.delete(oldestKey);
        }
    }

    private async handleGroupsUpdate(updates: Partial<GroupMetadata>[]): Promise<void> {
        const pipeline = this.client.multi();
        for (const update of updates) {
            if (update.id) {
                pipeline.set(this.key('groups', update.id), JSON.stringify(update));
            }
        }
        await pipeline.exec();
        this.logger.debug({ groupCount: updates.length }, 'Groups updated');
    }

    private async handleMessageReceiptUpdate(updates: { key: WAMessageKey, receipt: proto.IUserReceipt }[]): Promise<void> {
        const pipeline = this.client.multi();
        for (const { key, receipt } of updates) {
            // Convert IUserReceipt to CompatibleUserReceipt (if necessary)
            const compatibleReceipt = { ...receipt, toJSON: () => JSON.stringify(receipt) };

            const messageKey = this.key('messages', `${key.remoteJid}:${key.id}`);
            const msg = await this.loadMessage(key.remoteJid!, key.id!);
            if (msg) {
                updateMessageWithReceipt(msg, compatibleReceipt);
                pipeline.set(messageKey, JSON.stringify(msg));
                this.updateMessageCache(msg);
            }
        }
        await pipeline.exec();
        this.logger.debug({ updateCount: updates.length }, 'Message receipts updated');
    }


    private async handleMessagesReaction(reactions: { key: WAMessageKey, reaction: proto.IReaction }[]): Promise<void> {
        const pipeline = this.client.multi();
        for (const { key, reaction } of reactions) {
            const messageKey = this.key('messages', `${key.remoteJid}:${key.id}`);
            const msg = await this.loadMessage(key.remoteJid!, key.id!);
            if (msg) {
                updateMessageWithReaction(msg, reaction);
                pipeline.set(messageKey, JSON.stringify(msg));
                this.updateMessageCache(msg);
            }
        }
        await pipeline.exec();
        this.logger.debug({ reactionCount: reactions.length }, 'Message reactions updated');
    }

    private async handlePresenceUpdate({ id, presences }: { id: string, presences: { [participant: string]: PresenceData } }): Promise<void> {
        await this.client.set(this.key('presences', id), JSON.stringify(presences));
        this.logger.debug({ id, presenceCount: Object.keys(presences).length }, 'Presence updated');
    }

    private async handleChatsDelete(deletions: string[]): Promise<void> {
        const pipeline = this.client.multi();
        for (const jid of deletions) {
            pipeline.del(this.key('chats', jid));
            pipeline.del(this.key('message_list', jid));
            const messageKeys = await this.client.sMembers(this.key('message_global_list'));
            const chatMessageKeys = messageKeys.filter(key => key.startsWith(jid));
            for (const key of chatMessageKeys) {
                pipeline.sRem(this.key('message_global_list'), key);
                this.messageCache.delete(key);
            }
        }
        await pipeline.exec();
        this.logger.debug({ deletionCount: deletions.length }, 'Chats deleted');
    }

    private async handleMessagesDelete(item: { keys: WAMessageKey[] } | { jid: string, all: true }): Promise<void> {
        const pipeline = this.client.multi();
        if ('all' in item) {
            pipeline.del(this.key('message_list', item.jid));
            const messageKeys = await this.client.sMembers(this.key('message_global_list'));
            const chatMessageKeys = messageKeys.filter(key => key.startsWith(item.jid));
            for (const key of chatMessageKeys) {
                pipeline.sRem(this.key('message_global_list'), key);
                pipeline.del(this.key('messages', key));
                this.messageCache.delete(key);
            }
        } else {
            for (const key of item.keys) {
                const messageKey = `${key.remoteJid}:${key.id}`;
                pipeline.del(this.key('messages', messageKey));
                pipeline.zRem(this.key('message_list', key.remoteJid!), key.id!);
                pipeline.sRem(this.key('message_global_list'), messageKey);
                this.messageCache.delete(messageKey);
            }
        }
        await pipeline.exec();
        this.logger.debug({ item }, 'Messages deleted');
    }
    /**
     * Loads a single message from the cache or database.
     * 
     * @param {string} jid - The ID of the chat (e.g., phone number or group ID).
     * @param {string} id - The unique ID of the message.
     * @returns {Promise<WAMessage | null>} - A promise that resolves to the message if found, otherwise `null`.
     */
    async loadMessage(jid: string, id: string): Promise<WAMessage | undefined> {
        const cacheKey = `${jid}:${id}`;
        if (this.messageCache.has(cacheKey)) {
            return this.messageCache.get(cacheKey)!;
        }
        const msgStr = await this.client.get(this.key('messages', cacheKey));
        if (msgStr) {
            const msg = JSON.parse(msgStr) as WAMessage;
            this.updateMessageCache(msg);
            return msg;
        }
        return undefined;
    }

    /**
     * Loads a list of messages from the database.
     * 
     * @param {string} jid - The ID of the chat (e.g., phone number or group ID).
     * @param {number} count - The number of messages to retrieve.
     * @param {Object} [cursor] - Optional cursor for pagination.
     * @param {WAMessageKey} [cursor.before] - The key of the message before which to load messages.
     * @returns {Promise<WAMessage[]>} - A promise that resolves to an array of messages.
     */
    async loadMessages(jid: string, count: number, cursor?: { before?: WAMessageKey }): Promise<WAMessage[]> {
        const list = this.key('message_list', jid);
        let messages: (WAMessage | undefined)[] = []; // Allow undefined initially

        if (cursor?.before) {
            const cursorMessage = await this.loadMessage(cursor.before.remoteJid!, cursor.before.id!);
            if (cursorMessage) {
                const timestamp = Number(cursorMessage.messageTimestamp);
                const messageIds = await this.client.zRangeByScore(list, '-inf', String(timestamp), { LIMIT: { offset: 0, count } });
                messages = await Promise.all(messageIds.reverse().map(id => this.loadMessage(jid, id)));
            }
        } else {
            const messageIds = await this.client.zRange(list, -count, -1);
            messages = await Promise.all(messageIds.reverse().map(id => this.loadMessage(jid, id)));
        }

        // Filter out undefined values to satisfy the return type
        return messages.filter((msg): msg is WAMessage => msg !== undefined);
    }

    /**
     * Retrieves the content of a message.
     * 
     * @param {WAMessageKey} key - The key of the message to retrieve.
     * @returns {Promise<WAMessageContent | undefined>} - A promise that resolves to the message content if found, otherwise `undefined` or `null`.
     */
    async getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
        const msg = await this.loadMessage(key.remoteJid!, key.id!);
        return msg?.message || undefined;
    }

    /**
     * Searches for messages based on the given criteria.
     * 
     * @param {MessageSearchOptions} options - The search options.
     * @param {string} [options.messageId] - The ID of the message to search for.
     * @param {string} [options.remoteJid] - The ID of the chat to search in.
     * @param {string} [options.contentQuery] - The query to filter message content.
     * @param {number} [options.limit=50] - The maximum number of messages to return.
     * @param {number} [options.offset=0] - The number of messages to skip.
     * @returns {Promise<WAMessage[]>} - A promise that resolves to an array of matching messages.
     */
    async searchMessages(options: MessageSearchOptions): Promise<WAMessage[]> {
        const { messageId, remoteJid, contentQuery, limit = 50, offset = 0 } = options;
        let messageKeys: string[];

        if (messageId && remoteJid) {
            messageKeys = [`${remoteJid}:${messageId}`];
        } else if (messageId) {
            messageKeys = await this.client.sMembers(this.key('message_global_list'));
            messageKeys = messageKeys.filter(key => key.endsWith(`:${messageId}`));
        } else if (remoteJid) {
            const ids = await this.client.zRange(this.key('message_list', remoteJid), 0, -1);
            messageKeys = ids.map(id => `${remoteJid}:${id}`);
        } else {
            messageKeys = await this.client.sMembers(this.key('message_global_list'));
        }

        const messages = await Promise.all(messageKeys.map(key => {
            const parts = key.split(':');
            if (parts.length === 2) {
                return this.loadMessage(parts[0], parts[1]);
            } else {
                console.error('Unexpected key format:', key);
                return null;
            }
        }));

        const filteredMessages = messages.filter((msg): msg is WAMessage => {
            if (!msg) return false;
            if (contentQuery) {
                const messageContent = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.videoMessage?.caption ||
                    '';
                return messageContent.toLowerCase().includes(contentQuery.toLowerCase());
            }
            return true;
        });

        return filteredMessages.slice(offset, offset + limit);
    }

    /**
     * Retrieves chat details from the database.
     * 
     * @param {string} jid - The ID of the chat (e.g., phone number or group ID).
     * @returns {Promise<Chat | null>} - A promise that resolves to the chat details if found, otherwise `null`.
     */
    async getChat(jid: string): Promise<Chat | null> {
        const chat = await this.client.hGetAll(this.key('chats', jid));
        return Object.keys(chat).length > 0 ? chat as unknown as Chat : null;
    }

    /**
     * Retrieves contact details from the database.
     * 
     * @param {string} jid - The ID of the contact (e.g., phone number).
     * @returns {Promise<Contact | null>} - A promise that resolves to the contact details if found, otherwise `null`.
     */
    async getContact(jid: string): Promise<Contact | null> {
        const contact = await this.client.hGetAll(this.key('contacts', jid));
        return Object.keys(contact).length > 0 ? contact as unknown as Contact : null;
    }

    /**
     * Retrieves group metadata from the database.
     * 
     * @param {string} jid - The ID of the group (e.g., group ID).
     * @returns {Promise<GroupMetadata | null>} - A promise that resolves to the group metadata if found, otherwise `null`.
     */
    async getGroup(jid: string): Promise<GroupMetadata | null> {
        const group = await this.client.hGetAll(this.key('groups', jid));
        return Object.keys(group).length > 0 ? group as unknown as GroupMetadata : null;
    }

    /**
     * Clears all data from the Redis cache and local cache.
     * 
     * @returns {Promise<void>} - A promise that resolves when the data has been cleared.
     */
    async clearAll(): Promise<void> {
        const keys = await this.client.keys(`${this.prefix}*`);
        if (keys.length > 0) {
            await this.client.del(keys);
        }
        this.messageCache.clear();
        this.logger.info('All data cleared from Redis and local cache');
    }
}