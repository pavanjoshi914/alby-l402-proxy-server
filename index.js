require("dotenv").config();
const express = require("express");
const cors = require("cors");
const macaroon = require("macaroon");
const { NWCClient } = require("@getalby/sdk");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());
app.set("trust proxy", true);

const ROOT_KEY = process.env.ROOT_KEY || crypto.randomBytes(32).toString("hex");

const privateKeyPem = process.env.RSA_PRIVATE_KEY?.replace(/\\n/g, "\n");
const publicKeyPem = process.env.RSA_PUBLIC_KEY?.replace(/\\n/g, "\n");

if (!privateKeyPem || !publicKeyPem) {
  console.warn(
    "WARNING: RSA keys not found in environment variables. L402 Configuration via API might fail.",
  );
}

let serverConfig = {
  nwcUrl: null,
  priceSats: 10,
};

app.get("/api/config-key", (req, res) => {
  res.json({ publicKey: publicKeyPem });
});

app.post("/api/configure", (req, res) => {
  const { nwcUrl, encryptedNwcUrl } = req.body;

  if (encryptedNwcUrl) {
    try {
      const buffer = Buffer.from(encryptedNwcUrl, "base64");
      const decrypted = crypto.privateDecrypt(
        {
          key: privateKeyPem,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        buffer,
      );
      serverConfig.nwcUrl = decrypted.toString("utf8");
    } catch (error) {
      console.error("Decryption failed:", error);
      return res.status(400).json({ error: "Failed to decrypt NWC URL" });
    }
  } else if (nwcUrl !== undefined) {
    serverConfig.nwcUrl = nwcUrl;
  }

  res.json({
    success: true,
    config: {
      priceSats: serverConfig.priceSats,
      configured: !!serverConfig.nwcUrl,
    },
  });
});

async function l402Middleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("L402 ")) {
    return respondWithOffers(req, res);
  }

  const token = authHeader.replace("L402 ", "");
  const [pct] = token.split(":");

  if (!pct) {
    return res.status(400).json({ error: "Invalid L402 token format." });
  }

  try {
    const macaroonBytes = Buffer.from(pct, "base64url");
    const m = macaroon.importMacaroon(macaroonBytes);

    let paymentHash = null;
    m.verify(ROOT_KEY, (cav) => {
      if (cav.startsWith("payment_hash=")) {
        paymentHash = cav.split("=")[1];
        return null;
      }
      if (cav.startsWith("resource=")) {
        return null;
      }
      return new Error("Unknown caveat");
    });

    if (!paymentHash) {
      return res
        .status(400)
        .json({
          error: "Payment context token does not contain a payment hash caveat",
        });
    }

    if (!serverConfig.nwcUrl) {
      return res
        .status(503)
        .json({ error: "Server unavailable: Alice's NWC is not configured" });
    }

    const client = new NWCClient({
      nostrWalletConnectUrl: serverConfig.nwcUrl,
    });
    const invoiceData = await client.lookupInvoice({
      payment_hash: paymentHash,
    });

    if (!invoiceData || !invoiceData.settled_at) {
      return res
        .status(402)
        .json({ error: "Invoice has not been paid yet according to the node" });
    }

    next();
  } catch (error) {
    console.error("L402 verification failed:", error);
    return res
      .status(401)
      .json({ error: "Invalid payment context token or signature" });
  }
}

function respondWithOffers(req, res) {
  const m = macaroon.newMacaroon({
    rootKey: ROOT_KEY,
    identifier: crypto.randomBytes(16).toString("hex"),
    location: "localhost",
    version: 2,
  });
  m.addFirstPartyCaveat(`resource=${req.path}`);
  const pct = Buffer.from(m.exportBinary()).toString("base64url");

  res.status(402).json({
    version: "0.2.2",
    payment_request_url: `${req.protocol}://${req.get("host")}/api/payment-request`,
    payment_context_token: pct,
    offers: [
      {
        id: "offer_btc_10",
        title: "Bitcoin Price Access",
        description: "Access the live bitcoin price",
        type: "one-time",
        amount: serverConfig.priceSats,
        currency: "SATS",
        payment_methods: ["lightning"],
      },
    ],
  });
}

app.post("/api/payment-request", async (req, res) => {
  const { offer_id, payment_context_token, payment_method } = req.body;

  if (!serverConfig.nwcUrl) {
    return res
      .status(503)
      .json({ error: "Server unavailable: Alice has not connected NWC" });
  }

  try {
    const macaroonBytes = Buffer.from(payment_context_token, "base64url");
    const m = macaroon.importMacaroon(macaroonBytes);

    m.verify(ROOT_KEY, () => null);

    const client = new NWCClient({
      nostrWalletConnectUrl: serverConfig.nwcUrl,
    });
    const invoiceReq = await client.makeInvoice({
      amount: serverConfig.priceSats * 1000,
      description: "L402 Payment Required for Bitcoin Price (10 sats)",
    });

    m.addFirstPartyCaveat(`payment_hash=${invoiceReq.payment_hash}`);
    const newPct = Buffer.from(m.exportBinary()).toString("base64url");

    res.json({
      version: "0.2.2",
      payment_request: {
        lightning_invoice: invoiceReq.invoice,
      },
      payment_context_token: newPct, // send back updated token with hash
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  } catch (err) {
    console.error("Failed to generate invoice", err);
    res.status(500).json({ error: "Failed to generate invoice" });
  }
});

const getBitcoinPrice = async (req, res) => {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    );
    const data = await response.json();
    res.json({
      price: data.bitcoin.usd,
      currency: "USD",
      note: "This live Bitcoin price was served using the L402 protocol!",
    });
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Failed to fetch Bitcoin price" });
  }
};

app.get("/", l402Middleware, getBitcoinPrice);

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`L402 Server running on port ${PORT}`);
  });
}

module.exports = app;
