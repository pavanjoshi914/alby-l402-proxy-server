# Sandbox L402 Server implementation

This directory contains a standalone Node.js Express server demonstrating a highly compliant, strict implementation of the **L402 Protocol (Version 0.2.2)**. It acts as an autonomous API gateway integrating real Lightning Network payments before serving protected HTTP resources.

The server specifically adheres to the modern JSON-based `v0.2.2` flows outlined at [docs.l402.org](https://docs.l402.org) rather than the older `WWW-Authenticate` header string challenges.

---

## 🔒 L402 Payment Flow Architecture

The server implements a multi-step verification process entirely utilizing cryptographic **Macaroons** and the **Nostr Wallet Connect (NWC)** protocol (`@getalby/sdk`) to manage Lightning invoices directly from a connected wallet.

Here is the exact step-by-step process of the L402 integration:

### 1. Initial Discovery Request (`GET /api/bitcoin-price`)

- A client attempts an unauthenticated `GET` request to a protected endpoint.
- The `l402Middleware` intercepts the request. Detecting a lack of `Authorization`, the server generates a cryptographically signed **Macaroon** using a secure Root Key.
- The server adds a First-Party Caveat tying the Macaroon specifically to the requested route (`resource=/api/bitcoin-price`).
- The Macaroon is exported via `base64url` encoding, serving as the opaque `payment_context_token`.
- **Response**: The server returns an HTTP `402 Payment Required` with a JSON payload defining the available `offers` (pricing), the `payment_request_url`, and the initial `payment_context_token`.

### 2. Requesting the Invoice (`POST /api/payment-request`)

- The client selects a specific offer (e.g., 10 sats) and sends a `POST` request back to the server detailing their selected `payment_method` (Lightning) and the previously received `payment_context_token` (Base Macaroon).
- The server deserializes the `payment_context_token` and cryptographically verifies its root signature to ensure the session originated from this server.
- The server communicates with its connected Lightning Node / Wallet (via NWC) to generate a new Lightning Invoice for the specified price.
- **Macaroon Modification**: The server adds a _new_ First-Party Caveat to the existing Macaroon: `payment_hash=<generated_invoice_hash>`. Because Macaroon signatures chain transitively, adding this caveat updates the signature securely.
- **Response**: The server answers with the `lightning_invoice` alongside the newly expanded `payment_context_token`.

### 3. Payment Fulfillment (Out of Band)

- The client receives the invoice and leverages its native WebLN/NWC wallet interface to immediately pay the invoice over the Lightning Network.

### 4. Proof of Payment Request (`GET /api/bitcoin-price`)

- With the payment fulfilled, the client makes their second attempt to access the protected resource. This time, they provide the fully expanded `payment_context_token` in their request specific to the `v0.2.2` specification.
- **Header**: `Authorization: L402 <payment_context_token>`
- The `l402Middleware` intercepts the request. It strips the `L402` prefix and deserializes the Macaroon.
- The server iterates over the Macaroon's caveats. Finding the securely embedded `payment_hash`, it extracts it.
- **Native Verification**: Rather than looking for a cryptographically hashed raw preimage from the client, the server takes the `payment_hash` and autonomously queries its own NWC Client (`client.lookupInvoice({ payment_hash })`).
- If the connected Lightning node responds that the invoice is officially `settled`, the API access unlocks!
- **Response**: The backend finally executes the inner route handler, fetching external data (`api.coingecko.com`) and returning a `200 OK` JSON response holding the real-world Bitcoin price!

---

## Technical Details & Libraries

- **`macaroon`**: Used exclusively to handle `version: 2` binary Macaroon creation, Caveat chaining, and `base64url` serialization.
- **`@getalby/sdk`**: Instantiates headless Lightning interactions on behalf of Alice's server. Used to generate and verify L402 invoices via the user's NWC configuration without spinning up a physically tethered Lightning Node.
- **`crypto`**: Used for securing the session state via `ROOT_KEY` buffer validation.

## Running the Server

Since the L402 node acts as a standalone backend on port `3001`, ensure you start it separately from the main React web application:

\`\`\`bash
cd server
npm start

# Server listens internally at http://localhost:3001

\`\`\`
