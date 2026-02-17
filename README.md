> [!WARNING]
> This repository has been merged to the [main one](https://github.com/slopus/happy). All issues and code is now living there.

# Happy Server

Minimal backend for open-source end-to-end encrypted Claude Code clients.

## What is Happy?

Happy Server is the synchronization backbone for secure Claude Code clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🤝 **Session Sharing** - Collaborate on conversations with granular access control
- 🔔 **Push Notifications** - Notify when Claude Code finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Your Claude Code clients generate encryption keys locally and use Happy Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

### Session Sharing

Happy Server supports secure collaboration through two sharing methods:

**Direct Sharing**: Share sessions with specific users by username, with three access levels:
- **View**: Read-only access to messages
- **Edit**: Can send messages but cannot manage sharing
- **Admin**: Full access including sharing management

**Public Links**: Generate shareable URLs for broader access:
- Always read-only for security
- Optional expiration dates and usage limits
- Consent-based access logging (IP/UA only logged with explicit consent)

All sharing maintains end-to-end encryption - encrypted data keys are distributed to authorized users, and the server never sees unencrypted content.

## Hosting

**You don't need to self-host!** Our free cloud Happy Server at `happy-api.slopus.com` is just as secure as running your own. Since all data is end-to-end encrypted before it reaches our servers, we literally cannot read your messages even if we wanted to. The encryption happens on your device, and only you have the keys.

That said, Happy Server is open source and self-hostable if you prefer running your own infrastructure. The security model is identical whether you use our servers or your own.

## License

MIT - Use it, modify it, deploy it anywhere.
