# Home Game Server v1

## What is available in the Beebo desktop foundation

- A single local Minecraft server managed from **Beebo Host → Home Game Server**.
- An explicit Minecraft EULA acceptance step before Paper is downloaded.
- Download verification against the SHA-256 checksum provided by Paper's API.
- A Java 21-or-newer check before start.
- Owner controls for memory, player limit, Minecraft account sign-in, and whitelist mode.
- A local plugin-file picker. Plugin files are copied into this server's `plugins` folder only after the owner chooses them; they are recorded as owner-approved.
- Save-and-stop, start, activity log and deliberate deletion. Delete requires the exact phrase `DELETE MINECRAFT SERVER` and can only erase Beebo's managed Minecraft folder.
- No router, firewall, video-relay or arbitrary remote-network changes.

## Parent-control boundary

Beebo controls the Minecraft process and its server configuration. Windows account permissions protect its files. The recommended arrangement is a password-protected parent Windows account and separate standard Windows accounts for children. A person with Windows administrator access can still access local files and software; that is a Windows security boundary, not one Beebo can safely override.

## Connection status

Beebo Relay currently relays Beebo video connections only. It must not be presented as a Minecraft relay. A future Game Relay requires its own authenticated TCP/UDP tunnel, connection permits, port isolation, traffic accounting, rate limits, health checks, and regional routing. It must expose only the chosen game port, never the home network.

## Before public launch

1. Add owner re-authentication or Windows Hello before server-management actions.
2. Add encrypted, versioned world backups with restore previews.
3. Add a game-specific relay that is separately tested and metered.
4. Add crash-restart policy, resource monitoring, player visibility, and upgrade rollback.
5. Publish supported-game and plugin safety guidance. Minecraft is the only intended first game. Rust remains out of scope until isolated hardware and capacity controls are ready.
